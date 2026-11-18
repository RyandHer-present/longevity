//! The Dex: collections of everything the player has found in their world: mobs (the Field Guide),
//! ways they've died, biomes, pets and blocks. Everything comes from the player's own save, logs and
//! the recorder's sightings. Missing entries are listed (the player knows what's in Minecraft) but
//! nothing ever says where to find them.

use crate::{stats, Ctx};
use atlascore::logs::Session;
use mcassets::Assets;
use mcworld::nbt::{Value as Nbt, V};
use mcworld::Dim;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stamp {
    pub t: i64,
    #[serde(default)]
    pub day: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PetRec {
    pub id: String,
    pub name: Option<String>,
    pub variant: Option<String>,
    pub collar: Option<i64>,
    pub baby: bool,
    pub first: Option<Stamp>,
    pub before: bool,
    pub last_seen: i64,
    pub pos: [f64; 3],
    pub dim: String,
    pub gone: Option<Stamp>,
    pub gone_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(default)]
struct DexState {
    initialized: bool,
    /// key -> when it was first unlocked
    first: HashMap<String, Stamp>,
    /// keys that were already unlocked when the Dex started (no date known)
    before: HashSet<String>,
    /// keys the player has seen revealed (opened in a pack or in the first look)
    revealed: HashSet<String>,
    pets: HashMap<String, PetRec>,
    /// collections that existed when this state was saved (newer ones start quietly, without a pack)
    kinds: HashSet<String>,
}

const ALL_KINDS: &[&str] = &["mob", "death", "biome", "pet", "block", "adv", "disc", "variant", "plaque", "ench", "trim", "item"];

fn kind_of(k: &str) -> &str {
    k.split(':').next().unwrap_or("")
}

fn state_path(dir: &Path) -> std::path::PathBuf {
    dir.join("dex.json")
}

fn load_state(dir: &Path) -> DexState {
    std::fs::read(state_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(dir: &Path, s: &DexState) {
    let p = state_path(dir);
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(s).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(tmp, p);
    }
}

pub fn reveal(dir: &Path, keys: &[String]) {
    let mut s = load_state(dir);
    for k in keys {
        s.revealed.insert(k.clone());
    }
    save_state(dir, &s);
}

// ------------------------------------------------------------------ tables

fn mob_group(id: &str) -> &'static str {
    match id {
        "ender_dragon" | "wither" | "warden" | "elder_guardian" => "boss",
        "cod" | "salmon" | "tropical_fish" | "pufferfish" | "squid" | "glow_squid" | "axolotl" | "dolphin" | "turtle" | "tadpole" | "nautilus" | "guardian" | "drowned" | "zombie_nautilus" => "aquatic",
        "zombie" | "husk" | "skeleton" | "stray" | "bogged" | "parched" | "wither_skeleton" | "creeper" | "spider" | "cave_spider" | "witch" | "slime" | "magma_cube" | "phantom" | "blaze" | "ghast" | "shulker" | "silverfish" | "endermite" | "vex" | "vindicator" | "evoker" | "pillager" | "ravager"
        | "hoglin" | "zoglin" | "piglin_brute" | "breeze" | "creaking" | "zombie_villager" | "camel_husk" | "sulfur_cube" => "hostile",
        "enderman" | "piglin" | "zombified_piglin" | "wolf" | "bee" | "iron_golem" | "llama" | "trader_llama" | "polar_bear" | "panda" | "goat" => "neutral",
        _ => "passive",
    }
}

fn mob_rarity(id: &str) -> &'static str {
    match id {
        "ender_dragon" | "wither" | "warden" | "elder_guardian" => "legendary",
        "sniffer" | "allay" | "mooshroom" | "panda" | "breeze" | "creaking" | "happy_ghast" | "evoker" | "ravager" | "axolotl" | "piglin_brute" | "shulker" | "skeleton_horse" | "zombie_horse" | "nautilus" | "zombie_nautilus" | "illusioner" => "epic",
        "fox" | "parrot" | "ocelot" | "goat" | "armadillo" | "camel" | "frog" | "tadpole" | "dolphin" | "glow_squid" | "turtle" | "strider" | "hoglin" | "zoglin" | "ghast" | "blaze" | "magma_cube" | "vex" | "vindicator" | "pillager" | "witch" | "guardian" | "phantom" | "endermite" | "silverfish" | "wandering_trader"
        | "trader_llama" | "llama" | "bogged" | "stray" | "husk" | "wither_skeleton" | "polar_bear" | "bee" | "copper_golem" | "snow_golem" | "iron_golem" | "parched" | "camel_husk" | "sulfur_cube" | "mule" => "rare",
        "wolf" | "cat" | "horse" | "donkey" | "rabbit" | "slime" | "drowned" | "enderman" | "piglin" | "zombified_piglin" | "zombie_villager" | "spider" | "cave_spider" | "bat" | "squid" | "salmon" | "cod" | "tropical_fish" | "pufferfish" | "goat_horn" => "uncommon",
        _ => "common",
    }
}

const NETHER_BIOMES: &[&str] = &["nether_wastes", "soul_sand_valley", "crimson_forest", "warped_forest", "basalt_deltas"];
const END_BIOMES: &[&str] = &["the_end", "end_highlands", "end_midlands", "small_end_islands", "end_barrens"];
const CAVE_BIOMES: &[&str] = &["lush_caves", "dripstone_caves", "deep_dark"];

fn biome_dim(id: &str) -> &'static str {
    if NETHER_BIOMES.contains(&id) {
        "minecraft:the_nether"
    } else if END_BIOMES.contains(&id) {
        "minecraft:the_end"
    } else {
        "minecraft:overworld"
    }
}

/// (group, signature texture, tint) for a biome card's art.
fn biome_art(id: &str) -> (&'static str, &'static str, &'static str) {
    let has = |s: &str| id.contains(s);
    match id {
        "nether_wastes" => ("nether", "block/netherrack", ""),
        "soul_sand_valley" => ("nether", "block/soul_sand", ""),
        "crimson_forest" => ("nether", "block/crimson_nylium", ""),
        "warped_forest" => ("nether", "block/warped_nylium", ""),
        "basalt_deltas" => ("nether", "block/basalt_top", ""),
        "lush_caves" => ("cave", "block/moss_block", ""),
        "dripstone_caves" => ("cave", "block/dripstone_block", ""),
        "deep_dark" => ("cave", "block/sculk", ""),
        "mushroom_fields" => ("rare", "block/mycelium_top", ""),
        "cherry_grove" => ("forest", "block/cherry_leaves", ""),
        "pale_garden" => ("forest", "block/pale_moss_block", ""),
        "mangrove_swamp" => ("swamp", "block/mud", ""),
        "swamp" => ("swamp", "block/grass_block_top", "#6a7039"),
        "stony_peaks" | "stony_shore" => ("mountain", "block/stone", ""),
        "windswept_gravelly_hills" => ("mountain", "block/gravel", ""),
        "beach" => ("beach", "block/sand", ""),
        "snowy_beach" => ("snowy", "block/sand", ""),
        "desert" => ("desert", "block/sand", ""),
        "badlands" | "eroded_badlands" | "wooded_badlands" => ("desert", "block/red_sand", ""),
        "river" => ("water", "block/water_still", "#3f76e4"),
        "frozen_river" => ("snowy", "block/ice", ""),
        _ if END_BIOMES.contains(&id) => ("end", "block/end_stone", ""),
        _ if has("frozen") || has("ice") => ("snowy", "block/packed_ice", ""),
        _ if has("snowy") || has("grove") || has("frozen_peaks") || has("jagged") => ("snowy", "block/snow", ""),
        _ if has("ocean") => ("water", "block/water_still", if has("warm") { "#43d5ee" } else if has("lukewarm") { "#45adf2" } else if has("cold") { "#3d57d6" } else { "#3f76e4" }),
        _ if has("jungle") || has("bamboo") => ("jungle", "block/jungle_leaves", "#30bb0b"),
        _ if has("savanna") => ("desert", "block/grass_block_top", "#bfb755"),
        _ if has("taiga") => ("forest", "block/spruce_leaves", "#619961"),
        _ if has("forest") || has("birch") || has("dark") || has("dappled") => ("forest", "block/oak_leaves", "#59ae30"),
        _ if has("windswept") || has("peaks") || has("meadow") || has("hills") => ("mountain", "block/grass_block_top", "#79c05a"),
        _ => ("plains", "block/grass_block_top", "#91bd59"),
    }
}

fn block_group(id: &str) -> &'static str {
    let has = |s: &str| id.contains(s);
    let colored = ["white_", "orange_", "magenta_", "light_blue_", "yellow_", "lime_", "pink_", "gray_", "light_gray_", "cyan_", "purple_", "blue_", "brown_", "green_", "red_", "black_"];
    if has("_ore") || id == "ancient_debris" || id.starts_with("raw_") {
        return "ores";
    }
    if has("wool") || has("carpet") || has("concrete") || has("terracotta") || has("stained_glass") || has("candle") || has("_bed") || has("banner") || has("shulker_box") || (colored.iter().any(|c| id.starts_with(c)) && !has("tulip") && !has("mushroom")) {
        return "colors";
    }
    if has("redstone") || has("repeater") || has("comparator") || has("piston") || has("observer") || has("dispenser") || has("dropper") || has("hopper") || has("lever") || has("button") || has("pressure_plate") || has("rail") || id == "target" || has("daylight_detector") || has("tripwire") || id == "note_block" || has("sculk_sensor") || id == "crafter" || id == "tnt" || has("lightning_rod") || has("copper_bulb") {
        return "redstone";
    }
    if has("nether") || has("crimson") || has("warped") || has("blackstone") || has("basalt") || has("soul") || id == "magma_block" || id == "glowstone" || id == "shroomlight" || has("quartz") || id == "respawn_anchor" || id == "crying_obsidian" {
        return "nether";
    }
    if id.starts_with("end_") || has("purpur") || has("chorus") || id == "dragon_egg" || id == "dragon_head" {
        return "end";
    }
    if has("sapling") || has("leaves") || has("flower") || has("tulip") || has("orchid") || has("allium") || has("bluet") || has("daisy") || has("dandelion") || has("poppy") || has("cornflower") || has("lily") || has("rose") || has("lilac") || has("peony") || has("torchflower") || has("pitcher") || has("petals") || has("eyeblossom") || has("bush") || has("fern") || has("grass") && !has("grass_block") || has("vine") || has("moss") || has("kelp") || has("seagrass") || has("coral") || has("mushroom") || has("cactus") || has("sugar_cane") || id == "bamboo" || has("dripleaf") || has("spore_blossom") || has("azalea") || has("roots") || has("fungus") || has("sprouts") || has("wart") || has("propagule") || has("leaf_litter") || has("sea_pickle") || id == "melon" || has("pumpkin") || id == "hay_block" || id == "cocoa" || id == "lily_pad" || id == "sunflower" || has("wildflowers") || has("cactus_flower") {
        return "plants";
    }
    if has("_log") || has("_wood") || has("planks") || has("_stem") || has("hyphae") || has("bamboo_") || ["oak_", "spruce_", "birch_", "jungle_", "acacia_", "dark_oak_", "mangrove_", "cherry_", "pale_oak_"].iter().any(|w| id.starts_with(w)) {
        return "wood";
    }
    if has("prismarine") || id == "sea_lantern" || has("sponge") || id == "conduit" {
        return "ocean";
    }
    if matches!(
        id,
        "crafting_table" | "furnace" | "smoker" | "blast_furnace" | "chest" | "trapped_chest" | "barrel" | "enchanting_table" | "brewing_stand" | "cauldron" | "composter" | "grindstone" | "stonecutter" | "loom" | "cartography_table" | "fletching_table" | "smithing_table" | "lectern" | "bell" | "beacon" | "campfire" | "soul_campfire" | "lantern" | "torch" | "ladder" | "scaffolding" | "beehive" | "bee_nest" | "lodestone" | "jukebox" | "flower_pot" | "decorated_pot" | "chiseled_bookshelf" | "bookshelf" | "ender_chest" | "spawner" | "trial_spawner" | "vault" | "crafter" | "end_rod" | "chain" | "iron_bars" | "copper_chest"
    ) || has("anvil") || has("head") || has("skull") || has("lantern") || has("torch") || has("shelf") || has("chain")
    {
        return "utility";
    }
    if matches!(id, "stone" | "granite" | "diorite" | "andesite" | "deepslate" | "tuff" | "calcite" | "dirt" | "coarse_dirt" | "rooted_dirt" | "grass_block" | "podzol" | "mycelium" | "sand" | "red_sand" | "gravel" | "clay" | "mud" | "snow" | "snow_block" | "ice" | "packed_ice" | "blue_ice" | "obsidian" | "dripstone_block" | "pointed_dripstone" | "amethyst_block" | "budding_amethyst" | "amethyst_cluster" | "sculk" | "sculk_vein" | "sculk_catalyst" | "sculk_shrieker" | "farmland" | "dirt_path" | "suspicious_sand" | "suspicious_gravel" | "infested_stone" | "cobweb" | "bedrock" | "powder_snow" | "magma" | "honeycomb_block" | "bone_block" | "frogspawn" | "turtle_egg" | "sniffer_egg" | "resin_clump")
        || has("amethyst_bud")
        || has("infested")
        || has("cobblestone") && !has("stairs") && !has("slab") && !has("wall")
    {
        return "natural";
    }
    "building"
}

fn block_rarity(id: &str) -> &'static str {
    let has = |s: &str| id.contains(s);
    match id {
        "dragon_egg" | "beacon" | "conduit" | "netherite_block" | "heavy_core" | "dragon_head" => return "legendary",
        "diamond_block" | "emerald_block" | "ancient_debris" | "diamond_ore" | "deepslate_diamond_ore" | "emerald_ore" | "deepslate_emerald_ore" | "sculk_shrieker" | "sculk_catalyst" | "budding_amethyst" | "wet_sponge" | "sponge" | "respawn_anchor" | "lodestone" | "trial_spawner" | "vault" | "spawner" | "creaking_heart" | "sniffer_egg" | "wither_skeleton_skull" | "calibrated_sculk_sensor" | "enchanting_table" | "end_portal_frame" | "chorus_flower" => return "epic",
        "gold_block" | "lapis_block" | "gold_ore" | "deepslate_gold_ore" | "nether_gold_ore" | "lapis_ore" | "deepslate_lapis_ore" | "obsidian" | "crying_obsidian" | "amethyst_block" | "amethyst_cluster" | "blue_ice" | "sea_lantern" | "jukebox" | "bell" | "turtle_egg" | "suspicious_sand" | "suspicious_gravel" | "skeleton_skull" | "zombie_head" | "creeper_head" | "piglin_head" | "mushroom_stem" | "red_mushroom_block" | "brown_mushroom_block" | "end_rod" | "ender_chest" | "redstone_block" | "shulker_box" | "brewing_stand" | "beehive" | "bee_nest" | "honey_block" | "slime_block" | "pink_petals" | "spore_blossom" | "torchflower" | "pitcher_plant" | "wither_rose" | "frogspawn" => return "rare",
        _ => {}
    }
    if has("shulker_box") || has("coral") || id.starts_with("end_") || has("purpur") || has("chorus") || has("ochre_froglight") || has("froglight") || has("pearlescent") || has("verdant") {
        return "rare";
    }
    if has("nether") || has("crimson") || has("warped") || has("blackstone") || has("basalt") || has("soul") || has("copper") || has("prismarine") || id == "glowstone" || id == "magma_block" || id == "packed_ice" || has("_ore") || id == "iron_block" || has("anvil") || has("sculk") || has("amethyst") || has("quartz") || has("glazed") || has("cherry") || has("pale_") || has("resin") || has("mud") || has("bamboo") || has("dripstone") || has("tuff") || has("moss") {
        return "uncommon";
    }
    "common"
}

/// Blocks that can't be collected in survival (or aren't real blocks to collect).
fn roman(n: i64) -> String {
    const R: [&str; 10] = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
    if (1..=10).contains(&n) {
        R[(n - 1) as usize].to_string()
    } else {
        n.to_string()
    }
}

fn enchant_group(id: &str, tag: &str) -> &'static str {
    let t = tag.trim_start_matches("#minecraft:enchantable/");
    if id.contains("curse") {
        return "curses";
    }
    if matches!(id, "mending" | "unbreaking") {
        return "any";
    }
    match t {
        "foot_armor" | "leg_armor" | "chest_armor" | "head_armor" | "armor" | "equippable" => "armor",
        "sword" | "sharp_weapon" | "weapon" | "fire_aspect" | "melee_weapon" | "mace" | "lunge" | "spear" => "weapons",
        "bow" | "crossbow" => "ranged",
        "trident" => "trident",
        "mining" | "mining_loot" | "fishing" => "tools",
        _ if id.contains("protection") || matches!(id, "thorns" | "respiration" | "aqua_affinity" | "feather_falling" | "depth_strider" | "frost_walker" | "soul_speed" | "swift_sneak") => "armor",
        _ => "any",
    }
}

fn item_excluded(id: &str) -> bool {
    id.ends_with("_spawn_egg") || id.starts_with("music_disc_") || matches!(id, "debug_stick" | "knowledge_book" | "command_block_minecart")
}

fn item_group(id: &str) -> &'static str {
    const FOOD: &[&str] = &[
        "apple", "golden_apple", "enchanted_golden_apple", "melon_slice", "sweet_berries", "glow_berries", "chorus_fruit", "carrot", "golden_carrot", "potato", "baked_potato", "poisonous_potato", "beetroot", "beetroot_soup", "dried_kelp", "beef", "cooked_beef", "porkchop", "cooked_porkchop", "mutton", "cooked_mutton", "chicken", "cooked_chicken", "rabbit", "cooked_rabbit", "cod", "cooked_cod", "salmon", "cooked_salmon", "tropical_fish", "pufferfish", "bread", "cookie", "pumpkin_pie", "mushroom_stew", "rabbit_stew", "suspicious_stew", "rotten_flesh", "spider_eye", "honey_bottle", "milk_bucket",
    ];
    const BREW: &[&str] = &["potion", "splash_potion", "lingering_potion", "glass_bottle", "blaze_powder", "fermented_spider_eye", "glistering_melon_slice", "magma_cream", "ghast_tear", "dragon_breath", "rabbit_foot", "phantom_membrane", "glowstone_dust", "gunpowder", "sugar", "ominous_bottle", "experience_bottle", "breeze_rod"];
    const TOOLS: &[&str] = &["shears", "flint_and_steel", "fishing_rod", "carrot_on_a_stick", "warped_fungus_on_a_stick", "brush", "spyglass", "compass", "recovery_compass", "clock", "lead", "name_tag", "bucket", "map", "filled_map", "goat_horn", "writable_book", "written_book", "enchanted_book", "bundle", "trial_key", "ominous_trial_key"];
    const COMBAT: &[&str] = &["bow", "crossbow", "trident", "mace", "arrow", "spectral_arrow", "tipped_arrow", "shield", "totem_of_undying", "wind_charge", "turtle_helmet", "wolf_armor", "snowball", "egg", "blue_egg", "brown_egg", "fire_charge"];
    const TRANSPORT: &[&str] = &["minecart", "saddle", "elytra"];
    const DECOR: &[&str] = &["painting", "item_frame", "glow_item_frame", "armor_stand", "firework_rocket", "firework_star"];
    if FOOD.contains(&id) {
        "food"
    } else if BREW.contains(&id) {
        "brewing"
    } else if id.ends_with("_smithing_template") {
        "smithing"
    } else if COMBAT.contains(&id) || ["_sword", "_spear", "_helmet", "_chestplate", "_leggings", "_boots", "_horse_armor", "_nautilus_armor"].iter().any(|s| id.ends_with(s)) {
        "combat"
    } else if TOOLS.contains(&id) || ["_pickaxe", "_axe", "_shovel", "_hoe", "_bucket", "_bundle"].iter().any(|s| id.ends_with(s)) {
        "tools"
    } else if TRANSPORT.contains(&id) || ["_boat", "_raft", "_minecart"].iter().any(|s| id.ends_with(s)) {
        "transport"
    } else if id.ends_with("_dye") {
        "dyes"
    } else if DECOR.contains(&id) || ["_pottery_sherd", "_banner_pattern", "_harness"].iter().any(|s| id.ends_with(s)) {
        "decor"
    } else {
        "materials"
    }
}

fn item_rarity(id: &str) -> &'static str {
    const LEGEND: &[&str] = &["elytra", "totem_of_undying", "nether_star", "enchanted_golden_apple", "mace", "trident", "heart_of_the_sea", "dragon_breath", "silence_armor_trim_smithing_template", "netherite_upgrade_smithing_template"];
    const EPIC: &[&str] = &["echo_shard", "disc_fragment_5", "shulker_shell", "ominous_trial_key", "ominous_bottle", "recovery_compass", "nautilus_shell", "breeze_rod", "sniffer_egg", "creeper_banner_pattern", "skull_banner_pattern", "mojang_banner_pattern", "piglin_banner_pattern"];
    const RARE: &[&str] = &["diamond", "emerald", "golden_apple", "ender_pearl", "ender_eye", "blaze_rod", "ghast_tear", "trial_key", "phantom_membrane", "experience_bottle", "name_tag", "saddle", "wolf_armor", "goat_horn", "rabbit_foot", "enchanted_book", "armadillo_scute", "turtle_scute", "turtle_helmet", "spyglass", "prismarine_crystals", "wind_charge", "golden_carrot", "glistering_melon_slice", "netherite_scrap", "amethyst_shard", "lingering_potion", "firework_star"];
    if LEGEND.contains(&id) || (id.starts_with("netherite_") && id != "netherite_scrap") {
        "legendary"
    } else if EPIC.contains(&id) || id.ends_with("_smithing_template") || id.starts_with("diamond_") {
        "epic"
    } else if RARE.contains(&id) || id.ends_with("_horse_armor") || id.ends_with("_pottery_sherd") {
        "rare"
    } else if ["iron_", "golden_", "copper_", "chainmail_"].iter().any(|p| id.starts_with(p)) || id.ends_with("potion") || id.ends_with("_banner_pattern") || matches!(id, "lapis_lazuli" | "quartz" | "redstone" | "bow" | "crossbow" | "shield" | "compass" | "clock" | "map" | "filled_map" | "bundle" | "book" | "brush") {
        "uncommon"
    } else {
        "common"
    }
}

fn block_excluded(id: &str) -> bool {
    matches!(
        id,
        "air" | "command_block" | "chain_command_block" | "repeating_command_block" | "structure_block" | "structure_void" | "jigsaw" | "barrier" | "light" | "test_block" | "test_instance_block" | "bedrock" | "end_portal_frame" | "reinforced_deepslate" | "petrified_oak_slab" | "player_head" | "knowledge_book" | "debug_stick" | "farmland" | "dirt_path" | "budding_amethyst" | "spawner" | "trial_spawner" | "vault" | "frogspawn" | "infested_stone" | "infested_cobblestone" | "infested_stone_bricks" | "infested_mossy_stone_bricks" | "infested_cracked_stone_bricks" | "infested_chiseled_stone_bricks" | "infested_deepslate"
    )
}

// ------------------------------------------------------------------ death message matching

#[derive(Clone)]
struct DeathTpl {
    key: String,
    /// alternating literal / placeholder pieces
    pieces: Vec<(bool, String)>,
}

fn tpl_of(key: &str, template: &str) -> DeathTpl {
    let mut pieces = Vec::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        if i > 0 {
            pieces.push((false, rest[..i].to_string()));
        }
        let Some(j) = rest[i..].find('}') else { break };
        pieces.push((true, rest[i + 1..i + j].to_string()));
        rest = &rest[i + j + 1..];
    }
    if !rest.is_empty() {
        pieces.push((false, rest.to_string()));
    }
    DeathTpl { key: key.to_string(), pieces }
}

/// Match a chat death message against a template; returns the placeholder values in order.
fn match_tpl(t: &DeathTpl, msg: &str) -> Option<Vec<String>> {
    let mut pos = 0usize;
    let mut caps = Vec::new();
    let mut i = 0;
    while i < t.pieces.len() {
        let (ph, s) = &t.pieces[i];
        if !ph {
            if !msg[pos..].starts_with(s.as_str()) {
                return None;
            }
            pos += s.len();
            i += 1;
            continue;
        }
        let _ = s;
        // placeholder: up to the next literal (or the end)
        match t.pieces.get(i + 1) {
            Some((false, lit)) => {
                let f = msg[pos..].find(lit.as_str())?;
                caps.push(msg[pos..pos + f].to_string());
                pos += f;
            }
            _ => {
                caps.push(msg[pos..].to_string());
                pos = msg.len();
            }
        }
        i += 1;
    }
    (pos == msg.len()).then_some(caps)
}

fn base_death_key(k: &str) -> String {
    let mut k = k.to_string();
    for suf in [".item", ".player"] {
        if let Some(s) = k.strip_suffix(suf) {
            k = s.to_string();
        }
    }
    if let Some(s) = k.strip_suffix(".item") {
        k = s.to_string();
    }
    k
}

fn death_group(k: &str) -> &'static str {
    let s = k.trim_start_matches("death.attack.").trim_start_matches("death.");
    if k.starts_with("death.fell") || matches!(s, "fall" | "flyIntoWall" | "enderPearl") {
        return "fall";
    }
    match s {
        "inFire" | "onFire" | "lava" | "hotFloor" | "fireball" | "campfire" => "fire",
        "explosion" | "badRespawnPoint" | "fireworks" | "witherSkull" => "explosion",
        "mob" | "player" | "arrow" | "thrown" | "trident" | "sting" | "mace_smash" | "spit" | "windCharge" | "sonic_boom" | "thorns" | "indirectMagic" => "combat",
        "magic" | "wither" | "dragonBreath" | "even_more_magic" => "magic",
        "outOfWorld" | "outsideBorder" | "generic" | "genericKill" => "void",
        _ => "nature",
    }
}

/// How unusual a way to die is (fixed per kind, so locked cards show it too).
fn death_rarity(k: &str) -> &'static str {
    let s = k.trim_start_matches("death.");
    match s {
        "attack.badRespawnPoint.message" => "legendary",
        "attack.sonic_boom" | "attack.dragonBreath" | "attack.outOfWorld" | "attack.generic" | "attack.outsideBorder" => "epic",
        "attack.lightningBolt" | "attack.anvil" | "attack.trident" | "attack.fallingStalactite" | "attack.stalagmite" | "attack.dryout" | "attack.cramming" | "attack.thorns"
        | "attack.fireworks" | "attack.witherSkull" | "attack.flyIntoWall" | "attack.mace_smash" | "attack.spear" | "attack.sulfurCubeHot" | "attack.freeze" => "rare",
        "attack.mob" | "attack.drown" | "attack.lava" | "attack.explosion" | "attack.arrow" | "attack.inFire" | "attack.onFire" | "attack.fall" | "fell.accident.generic" => "common",
        _ => "uncommon",
    }
}

fn death_title(template: &str) -> String {
    let mut t = template.trim_start_matches("{0}").trim().to_string();
    for w in ["was ", "were "] {
        if let Some(s) = t.strip_prefix(w) {
            t = s.to_string();
        }
    }
    if template.contains("[") {
        return "Killed by Intentional Game Design".into();
    }
    let t = t.replace("{1}", "a foe").replace("{2}", "an item");
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => t,
    }
}

// ------------------------------------------------------------------ helpers

fn criteria_dates(adv: &Value, id: &str) -> HashMap<String, i64> {
    adv.get(id)
        .and_then(|a| a.get("criteria"))
        .and_then(|c| c.as_object())
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().and_then(stats::parse_mc_date).map(|t| (k.clone(), t))).collect())
        .unwrap_or_default()
}

fn uuid_ints(u: &str) -> Option<[i32; 4]> {
    let hex: String = u.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0i32; 4];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok()? as i32;
    }
    Some(out)
}

fn is_uuid(v: Option<&Nbt>, me: &[i32; 4]) -> bool {
    v.and_then(|x| x.int_array()).map(|a| a.len() == 4 && a.iter().zip(me.iter()).all(|(x, y)| *x == *y)).unwrap_or(false)
}

fn attr(en: &Nbt, name: &str) -> Option<f64> {
    en.get_list("attributes").iter().find(|a| a.get_str("id").map(|i| i.ends_with(name)).unwrap_or(false)).and_then(|a| a.get_f64("base"))
}

fn variant_of(en: &Nbt) -> Option<String> {
    en.get_str("variant")
        .or_else(|| en.get_str("Variant"))
        .map(|s| s.to_string())
        .or_else(|| en.get_i64("Variant").map(|v| v.to_string()))
        .or_else(|| en.get_i64("RabbitType").map(|v| v.to_string()))
        .or_else(|| en.get_i64("CatType").map(|v| v.to_string()))
}

struct EntityHit {
    id: String,
    dim: Dim,
    pos: [f64; 3],
    var: Option<&'static str>,
}

struct Pet {
    uuid: String,
    id: String,
    name: Option<String>,
    variant: Option<String>,
    collar: Option<i64>,
    baby: bool,
    health: Option<f64>,
    max_health: Option<f64>,
    speed: Option<f64>,
    jump: Option<f64>,
    sitting: bool,
    pos: [f64; 3],
    dim: Dim,
    kind: &'static str,
    var: Option<&'static str>,
}

/// Every entity in every dimension: pets owned by the player, plus all creatures (for sightings).
fn scan_entities(ctx: &Ctx, me: Option<[i32; 4]>) -> (Vec<Pet>, Vec<EntityHit>) {
    let mut jobs = Vec::new();
    for d in Dim::all() {
        for (rx, rz, _) in ctx.world.entity_regions(d) {
            jobs.push((d, rx, rz));
        }
    }
    let results: Vec<(Vec<Pet>, Vec<EntityHit>)> = jobs
        .par_iter()
        .map(|&(d, rx, rz)| {
            let mut pets = Vec::new();
            let mut hits = Vec::new();
            for en in ctx.world.entities_in_region(d, rx, rz) {
                let id = en.get_str("id").unwrap_or("").to_string();
                if !atlascore::sightings::is_creature(&id) {
                    continue;
                }
                let pl = en.get_list("Pos");
                if pl.len() != 3 {
                    continue;
                }
                let pos = [pl[0].f64().unwrap_or(0.0), pl[1].f64().unwrap_or(0.0), pl[2].f64().unwrap_or(0.0)];
                let var = mcworld::variants::rare_variant(&en);
                if let Some(me) = &me {
                    let owned = is_uuid(en.get("Owner"), me);
                    let trusted = en.get_list("Trusted").iter().any(|t| is_uuid(Some(t), me));
                    let liked = en.path(&["Brain", "memories", "minecraft:liked_player", "value"]).map(|v| is_uuid(Some(v), me)).unwrap_or(false);
                    if owned || trusted || liked {
                        pets.push(Pet {
                            uuid: en.get("UUID").and_then(mcworld::nbt::uuid_from_ints).unwrap_or_default(),
                            id: id.clone(),
                            name: en.get("CustomName").map(mcworld::nbt::text_of).filter(|s| !s.is_empty()),
                            variant: variant_of(&en),
                            collar: en.get_i64("CollarColor"),
                            baby: en.get_i64("Age").map(|a| a < 0).unwrap_or(false),
                            health: en.get_f64("Health"),
                            max_health: attr(&en, "max_health"),
                            speed: attr(&en, "movement_speed"),
                            jump: attr(&en, "jump_strength"),
                            sitting: en.get_i64("Sitting").map(|b| b != 0).unwrap_or(false) || en.get_i64("OrderedToSit").map(|b| b != 0).unwrap_or(false),
                            pos,
                            dim: d,
                            kind: if owned { "tamed" } else if trusted { "trusts you" } else { "friend" },
                            var,
                        });
                    }
                }
                for r in en.get_list("Passengers") {
                    if let Some(rid) = r.get_str("id").filter(|r| atlascore::sightings::is_creature(r)) {
                        hits.push(EntityHit { id: rid.to_string(), dim: d, pos, var: mcworld::variants::rare_variant(r) });
                    }
                }
                hits.push(EntityHit { id, dim: d, pos, var });
            }
            (pets, hits)
        })
        .collect();
    let mut pets = Vec::new();
    let mut hits = Vec::new();
    for (p, h) in results {
        pets.extend(p);
        hits.extend(h);
    }
    (pets, hits)
}

/// Surface biome of every chunk the player spent time in: (biome, dim, cx, cz, inhabited, y).
/// Cached per region file in <world dir>/dex-biomes.json.
#[derive(Serialize, Deserialize, Default)]
struct BiomeCache {
    ver: u32,
    regions: HashMap<String, (i64, Vec<(String, i32, i32, i64, i32)>)>,
}

fn biome_scan(ctx: &Ctx) -> Vec<(String, Dim, i32, i32, i64, i32)> {
    let path = ctx.dir.join("dex-biomes.json");
    let mut cache: BiomeCache = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if cache.ver != 2 {
        cache = BiomeCache { ver: 2, ..Default::default() };
    }
    let mut jobs = Vec::new();
    for d in Dim::all() {
        let e = ctx.explored(d);
        let mut by_region: HashMap<(i32, i32), Vec<(i32, i32, i64)>> = HashMap::new();
        for (&(cx, cz), &t) in &e.visited {
            if t >= 400 {
                by_region.entry((cx >> 5, cz >> 5)).or_default().push((cx, cz, t));
            }
        }
        for ((rx, rz), chunks) in by_region {
            let p = ctx.world.dim_dir(d).join("region").join(format!("r.{rx}.{rz}.mca"));
            let mt = mcworld::world::mtime_ms(&p);
            let key = format!("{}|{rx}|{rz}", d.id());
            jobs.push((d, key, p, mt, chunks));
        }
    }
    let fresh: Vec<(String, i64, Vec<(String, i32, i32, i64, i32)>)> = jobs
        .par_iter()
        .filter(|(_, key, _, mt, _)| cache.regions.get(key).map(|c| c.0 != *mt).unwrap_or(true))
        .map(|(d, key, p, mt, chunks)| {
            let mut out = Vec::new();
            if let Ok(r) = mcworld::region::Region::open(p) {
                for &(cx, cz, t) in chunks {
                    let Some(c) = mcworld::World::chunk_uncached(&r, (cx & 31) as usize, (cz & 31) as usize) else { continue };
                    let y = match d {
                        Dim::Overworld => c.motion.as_ref().map(|m| m[8 * 16 + 8]).unwrap_or(64),
                        Dim::Nether => 64,
                        Dim::End => c.motion.as_ref().map(|m| m[8 * 16 + 8]).unwrap_or(60).max(0),
                    };
                    let sy = y.div_euclid(16);
                    if sy < c.min_section {
                        continue;
                    }
                    let Some(Some(sec)) = c.sections.get((sy - c.min_section) as usize) else { continue };
                    let cell = (((y.rem_euclid(16)) >> 2) * 16 + 2 * 4 + 2) as usize;
                    let Some(b) = sec.biomes.get(cell).and_then(|i| sec.biome_palette.get(*i as usize)) else { continue };
                    out.push((b.clone(), cx, cz, t, y + 1));
                }
            }
            (key.clone(), *mt, out)
        })
        .collect();
    let changed = !fresh.is_empty();
    for (k, mt, v) in fresh {
        cache.regions.insert(k, (mt, v));
    }
    if changed {
        let _ = std::fs::write(&path, serde_json::to_vec(&cache).unwrap_or_default());
    }
    let mut out = Vec::new();
    for (k, (_, v)) in &cache.regions {
        let d = Dim::from_id(k.split('|').next().unwrap_or("")).unwrap_or(Dim::Overworld);
        for (b, cx, cz, t, y) in v {
            out.push((b.clone(), d, *cx, *cz, *t, *y));
        }
    }
    out
}

// ------------------------------------------------------------------ the dex

pub fn compute(ctx: &Ctx, assets: &Assets, sessions: &[Session]) -> Value {
    let now = atlascore::now_ms();
    let level = ctx.world.level().ok();
    let day_time = level.as_ref().map(|l| l.day_time).unwrap_or(0);
    let now_day = day_time as f64 / 24000.0;
    let clock = stats::DayClock::new(sessions, day_time);
    let stamp_at = |t: i64| Stamp { t, day: Some(clock.day_at(t)) };
    let uuid = ctx.player_uuid.clone().unwrap_or_default();
    let me = uuid_ints(&uuid);
    // (singleplayer saves these whenever the game pauses, so alt-tabbing to Atlas sees them fresh)
    let st = ctx.world.stats_json(&uuid).unwrap_or(Value::Null);
    let adv = ctx.world.advancements_json(&uuid).unwrap_or(Value::Null);
    let stat = |cat: &str, id: &str| st.pointer(&format!("/stats/minecraft:{cat}/{}", id.replace('/', "~1"))).and_then(|v| v.as_i64()).unwrap_or(0);
    let mut state = load_state(&ctx.dir);
    let first_run = !state.initialized;
    let lang = &assets.lang;

    // known dates per key, from the game's own records
    let mut dated: HashMap<String, i64> = HashMap::new();
    fn note(dated: &mut HashMap<String, i64>, k: String, t: i64) {
        let e = dated.entry(k).or_insert(t);
        if t < *e {
            *e = t;
        }
    }

    // ---------------- mobs
    let (pets_now, hits) = scan_entities(ctx, me);
    let sightings = atlascore::sightings::load_all(&ctx.dir);
    let mut mob_ids: Vec<String> = lang
        .map
        .keys()
        .filter_map(|k| k.strip_prefix("item.minecraft.").and_then(|s| s.strip_suffix("_spawn_egg")).map(|s| s.to_string()))
        .collect();
    for extra in ["ender_dragon", "wither"] {
        if !mob_ids.iter().any(|m| m == extra) && lang.map.contains_key(&format!("entity.minecraft.{extra}")) {
            mob_ids.push(extra.to_string());
        }
    }
    mob_ids.retain(|m| !matches!(m.as_str(), "giant" | "illusioner") && lang.map.contains_key(&format!("entity.minecraft.{m}")));
    mob_ids.sort();
    for c in ["minecraft:adventure/kill_all_mobs", "minecraft:adventure/kill_a_mob"] {
        for (k, t) in criteria_dates(&adv, c) {
            if k.starts_with("minecraft:") {
                note(&mut dated, format!("mob:{k}"), t);
            }
        }
    }
    for c in ["minecraft:husbandry/bred_all_animals"] {
        for (k, t) in criteria_dates(&adv, c) {
            note(&mut dated, format!("mob:{k}"), t);
        }
    }
    for (id, s) in &sightings {
        note(&mut dated, format!("mob:{id}"), s.t);
    }
    // creatures saved in places the player spent real time, out in the open (or in the Nether/End)
    let explored: HashMap<Dim, std::sync::Arc<crate::explore::Explored>> = Dim::all().into_iter().map(|d| (d, ctx.explored(d))).collect();
    let seen_open = |h: &EntityHit, need_sky: bool| -> bool {
        let c = ((h.pos[0].floor() as i32) >> 4, (h.pos[2].floor() as i32) >> 4);
        let inhabited = explored.get(&h.dim).and_then(|e| e.visited.get(&c)).copied().unwrap_or(0);
        if inhabited < 2400 {
            return false;
        }
        if h.dim != Dim::Overworld || !need_sky {
            return true;
        }
        ctx.world
            .chunk(h.dim, c.0, c.1)
            .and_then(|ch| {
                let y = h.pos[1].floor() as i32 + 1;
                let l = ch.light(y.div_euclid(16))?;
                Some(l.sky_at(h.pos[0].floor().rem_euclid(16.0) as usize, y.rem_euclid(16) as usize, h.pos[2].floor().rem_euclid(16.0) as usize) >= 8)
            })
            .unwrap_or(false)
    };
    let mut world_seen: HashMap<String, u32> = HashMap::new();
    {
        let mut by_type: HashMap<&str, Vec<&EntityHit>> = HashMap::new();
        for h in &hits {
            by_type.entry(h.id.as_str()).or_default().push(h);
        }
        for (id, list) in by_type {
            let n = list.iter().take(400).filter(|h| seen_open(h, true)).take(3).count() as u32;
            if n > 0 {
                world_seen.insert(id.to_string(), n);
            }
        }
    }
    // rare variants: same rule, but a pet indoors at the base counts too
    let variants_seen: HashSet<&'static str> = hits.iter().filter(|h| h.var.is_some() && seen_open(h, !matches!(h.id.as_str(), "minecraft:cat" | "minecraft:wolf" | "minecraft:fox" | "minecraft:axolotl"))).filter_map(|h| h.var).collect();
    let mut pets_by_type: HashMap<String, u32> = HashMap::new();
    for p in &pets_now {
        *pets_by_type.entry(p.id.clone()).or_default() += 1;
    }
    let mut out_mobs = Vec::new();
    let mut unlocked_keys: Vec<(String, Option<i64>)> = Vec::new();
    for m in &mob_ids {
        let id = format!("minecraft:{m}");
        let key = format!("mob:{id}");
        let killed = stat("killed", &id);
        let killed_by = stat("killed_by", &id);
        let tamed = pets_by_type.get(&id).copied().unwrap_or(0);
        let sighted = sightings.get(&id);
        let near = world_seen.contains_key(&id);
        let unlocked = killed > 0 || killed_by > 0 || tamed > 0 || sighted.is_some() || near || dated.contains_key(&key);
        let how = if tamed > 0 {
            "tamed"
        } else if killed > 0 {
            "defeated"
        } else if killed_by > 0 {
            "defeated you"
        } else {
            "seen"
        };
        if unlocked {
            unlocked_keys.push((key.clone(), dated.get(&key).copied()));
        }
        out_mobs.push(json!({
            "key": key, "id": id, "name": lang.entity_name(&id),
            "group": mob_group(m), "rarity": mob_rarity(m),
            "unlocked": unlocked, "how": how,
            "killed": killed, "killed_by": killed_by, "tamed": tamed,
            "seen_times": sighted.map(|s| s.n).unwrap_or(0), "most": sighted.map(|s| s.most).unwrap_or(0),
        }));
    }

    // ---------------- deaths
    let all_patterns = lang.death_patterns();
    let tpl_by_key: HashMap<&str, &str> = all_patterns.iter().map(|p| (p.key.as_str(), p.template.as_str())).collect();
    let patterns: Vec<DeathTpl> = all_patterns.iter().filter(|p| !p.key.ends_with(".link") && p.key != "death.attack.message_too_long").map(|p| tpl_of(&p.key, &p.template)).collect();
    let mut cards: Vec<(String, String)> = Vec::new(); // base key, title
    {
        let mut seen = HashSet::new();
        let mut keys: Vec<&DeathTpl> = patterns.iter().collect();
        keys.sort_by(|a, b| a.key.cmp(&b.key));
        for p in keys {
            let b = base_death_key(&p.key);
            if matches!(b.as_str(), "death.attack.genericKill" | "death.attack.even_more_magic" | "death.attack.player") || !seen.insert(b.clone()) {
                continue;
            }
            let tpl = tpl_by_key.get(b.as_str()).map(|s| s.to_string()).unwrap_or_default();
            if tpl.is_empty() {
                continue;
            }
            let title = if b.contains("badRespawnPoint") { "Killed by Intentional Game Design".to_string() } else { death_title(&tpl) };
            cards.push((b, title));
        }
    }
    struct DeathHit {
        t: i64,
        msg: String,
        killer: Option<String>,
    }
    let mut died: HashMap<String, Vec<DeathHit>> = HashMap::new();
    let mut matched = 0i64;
    let player = ctx.player_name.clone();
    for s in sessions {
        for e in s.events.iter().filter(|e| e.kind == "death") {
            for p in &patterns {
                let Some(caps) = match_tpl(p, &e.title) else { continue };
                if caps.first().map(|c| c != &player && !player.is_empty() && player != "Player").unwrap_or(false) {
                    continue;
                }
                matched += 1;
                died.entry(base_death_key(&p.key)).or_default().push(DeathHit { t: e.t, msg: e.title.clone(), killer: caps.get(1).cloned().filter(|k| !k.is_empty()) });
                break;
            }
        }
    }
    let total_deaths = stat("custom", "minecraft:deaths");
    let mut out_deaths = Vec::new();
    for (k, title) in &cards {
        let key = format!("death:{k}");
        let hits = died.get(k);
        let n = hits.map(|h| h.len()).unwrap_or(0);
        let first = hits.and_then(|h| h.iter().map(|x| x.t).min());
        let last = hits.and_then(|h| h.iter().max_by_key(|x| x.t));
        let mut killers: HashMap<String, u32> = HashMap::new();
        for h in hits.into_iter().flatten() {
            if let Some(k) = &h.killer {
                *killers.entry(k.clone()).or_default() += 1;
            }
        }
        if let Some(t) = first {
            note(&mut dated, key.clone(), t);
            unlocked_keys.push((key.clone(), Some(t)));
        }
        out_deaths.push(json!({
            "key": key, "id": k, "name": title, "group": death_group(k),
            "rarity": death_rarity(k),
            "unlocked": n > 0, "count": n,
            "last": last.map(|l| json!({ "t": l.t, "day": clock.day_at(l.t), "message": l.msg })),
            "killers": killers,
        }));
    }

    // ---------------- biomes
    let mut biome_ids: Vec<String> = lang.map.keys().filter_map(|k| k.strip_prefix("biome.minecraft.").map(|s| s.to_string())).filter(|b| b != "the_void" && !b.contains('.')).collect();
    biome_ids.sort();
    for c in ["minecraft:adventure/adventuring_time", "minecraft:nether/explore_nether"] {
        for (k, t) in criteria_dates(&adv, c) {
            note(&mut dated, format!("biome:{k}"), t);
        }
    }
    // biomes the in-game companion saw you standing in
    for (k, s) in &sightings {
        if k.starts_with("biome:") {
            note(&mut dated, k.clone(), s.t);
        }
    }
    let scan = biome_scan(ctx);
    let mut best: HashMap<String, (Dim, i32, i32, i64, i32)> = HashMap::new();
    for (b, d, cx, cz, t, y) in &scan {
        let e = best.entry(b.clone()).or_insert((*d, *cx, *cz, *t, *y));
        if *t > e.3 {
            *e = (*d, *cx, *cz, *t, *y);
        }
    }
    let mut out_biomes = Vec::new();
    for b in &biome_ids {
        let id = format!("minecraft:{b}");
        let key = format!("biome:{id}");
        let spot = best.get(&id);
        let unlocked = dated.contains_key(&key) || spot.map(|s| s.3 >= 2400 || END_BIOMES.contains(&b.as_str())).unwrap_or(false);
        if unlocked {
            unlocked_keys.push((key.clone(), dated.get(&key).copied()));
        }
        let (group, tex, tint) = biome_art(b);
        out_biomes.push(json!({
            "key": key, "id": id, "name": lang.name(&id), "dim": biome_dim(b), "group": group, "tex": tex, "tint": tint,
            "rarity": match group { "rare" | "end" => "epic", "cave" | "nether" => "rare", "jungle" | "snowy" | "swamp" | "mountain" => "uncommon", _ => if b.contains("deep") || b.contains("warm") || b.contains("cherry") || b.contains("pale") || b.contains("badlands") || b.contains("ice_spikes") || b.contains("bamboo") { "rare" } else { "common" } },
            "unlocked": unlocked,
            "cave": CAVE_BIOMES.contains(&b.as_str()),
            "spot": if unlocked && !CAVE_BIOMES.contains(&b.as_str()) { spot.map(|s| json!({ "dim": s.0.id(), "pos": [s.1 * 16 + 8, s.4, s.2 * 16 + 8], "minutes": s.3 / 1200 })) } else { None },
        }));
    }

    // ---------------- pets
    let named_deaths: Vec<(i64, String, String)> = sessions.iter().flat_map(|s| s.events.iter().filter(|e| e.kind == "villager_death").map(|e| (e.t, e.detail.clone(), e.title.clone()))).collect();
    let present: HashSet<String> = pets_now.iter().map(|p| p.uuid.clone()).collect();
    for p in &pets_now {
        let rec = state.pets.entry(p.uuid.clone()).or_insert_with(|| PetRec {
            id: p.id.clone(),
            first: if first_run { None } else { Some(Stamp { t: now, day: Some(now_day) }) },
            before: first_run,
            ..Default::default()
        });
        rec.id = p.id.clone();
        rec.name = p.name.clone();
        rec.variant = p.variant.clone();
        rec.collar = p.collar;
        rec.baby = p.baby;
        rec.last_seen = now;
        rec.pos = p.pos;
        rec.dim = p.dim.id().to_string();
        rec.gone = None;
        rec.gone_reason = None;
    }
    for (u, rec) in state.pets.iter_mut() {
        if present.contains(u) || rec.gone.is_some() {
            continue;
        }
        // its entity region was saved again without it: the pet is gone
        let d = Dim::from_id(&rec.dim).unwrap_or(Dim::Overworld);
        let rp = ctx.world.dim_dir(d).join("entities").join(format!("r.{}.{}.mca", (rec.pos[0].floor() as i32) >> 9, (rec.pos[2].floor() as i32) >> 9));
        if mcworld::world::mtime_ms(&rp) <= rec.last_seen {
            continue;
        }
        let death = rec.name.as_ref().and_then(|n| named_deaths.iter().filter(|(t, who, _)| who == n && *t >= rec.last_seen - 600_000).min_by_key(|(t, _, _)| *t));
        rec.gone = Some(match death {
            Some((t, _, _)) => stamp_at(*t),
            None => Stamp { t: now, day: Some(now_day) },
        });
        rec.gone_reason = death.map(|(_, _, m)| m.clone());
    }
    let mut out_pets = Vec::new();
    for (u, rec) in &state.pets {
        let live = pets_now.iter().find(|p| &p.uuid == u);
        let key = format!("pet:{u}");
        unlocked_keys.push((key.clone(), rec.first.as_ref().map(|f| f.t)));
        let species = lang.entity_name(&rec.id);
        out_pets.push(json!({
            "key": key, "uuid": u, "id": rec.id, "species": species, "name": rec.name, "unlocked": true,
            "variant": rec.variant, "collar": rec.collar, "baby": rec.baby,
            "alive": rec.gone.is_none(), "gone": rec.gone, "gone_reason": rec.gone_reason,
            "first": rec.first, "before": rec.before,
            "health": live.and_then(|p| p.health), "max_health": live.and_then(|p| p.max_health),
            "speed": live.and_then(|p| p.speed), "jump": live.and_then(|p| p.jump),
            "sitting": live.map(|p| p.sitting).unwrap_or(false),
            "pos": rec.pos, "dim": rec.dim,
            "kind": live.map(|p| p.kind).unwrap_or("tamed"),
            "rarity": mob_rarity(rec.id.trim_start_matches("minecraft:")),
        }));
    }
    out_pets.sort_by(|a, b| {
        let alive = |v: &Value| v["alive"].as_bool().unwrap_or(false);
        let t = |v: &Value| v["first"]["t"].as_i64().unwrap_or(0);
        alive(b).cmp(&alive(a)).then(t(a).cmp(&t(b)))
    });

    // ---------------- blocks
    let mut block_ids: Vec<String> = assets
        .jar
        .list("items/")
        .filter_map(|p| p.strip_prefix("items/").and_then(|s| s.strip_suffix(".json")).map(|s| s.to_string()))
        .filter(|id| lang.map.contains_key(&format!("block.minecraft.{id}")) && !block_excluded(id))
        .collect();
    block_ids.sort();
    let mut out_blocks = Vec::new();
    for b in &block_ids {
        let id = format!("minecraft:{b}");
        let key = format!("block:{id}");
        let mined = stat("mined", &id);
        let placed = stat("used", &id);
        let unlocked = mined > 0 || placed > 0;
        if unlocked {
            unlocked_keys.push((key.clone(), None));
        }
        out_blocks.push(json!({
            "key": key, "id": id, "name": lang.name(&id), "group": block_group(b), "rarity": block_rarity(b),
            "unlocked": unlocked, "mined": mined, "placed": placed,
            "picked": stat("picked_up", &id), "crafted": stat("crafted", &id),
        }));
    }

    // ---------------- advancements
    let mut out_advs = Vec::new();
    {
        let cats = ["story", "nether", "end", "adventure", "husbandry"];
        let paths: Vec<String> = assets.jar.list("data/minecraft/advancement/").map(|s| s.to_string()).collect();
        struct A {
            id: String,
            parent: Option<String>,
            j: Value,
        }
        let mut all: HashMap<String, A> = HashMap::new();
        for p in &paths {
            let Some(rest) = p.strip_prefix("data/minecraft/advancement/").and_then(|s| s.strip_suffix(".json")) else { continue };
            if rest.starts_with("recipes/") || !cats.iter().any(|c| rest.starts_with(&format!("{c}/"))) {
                continue;
            }
            let Some(j) = assets.jar.json(p) else { continue };
            if j.get("display").is_none() {
                continue;
            }
            let id = format!("minecraft:{rest}");
            let parent = j.get("parent").and_then(|v| v.as_str()).map(|s| s.to_string());
            all.insert(id.clone(), A { id, parent, j });
        }
        // tree order: each tab's root, then its children depth-first (alphabetical by title)
        let text = |v: &Value| -> String {
            match v {
                Value::String(s) => s.clone(),
                _ => v
                    .get("translate")
                    .and_then(|t| t.as_str())
                    .and_then(|k| lang.get(k))
                    .map(|s| s.to_string())
                    .or_else(|| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default(),
            }
        };
        let mut kids: HashMap<String, Vec<String>> = HashMap::new();
        for a in all.values() {
            if let Some(p) = &a.parent {
                kids.entry(p.clone()).or_default().push(a.id.clone());
            }
        }
        for v in kids.values_mut() {
            v.sort_by_key(|id| all.get(id).map(|a| text(&a.j["display"]["title"])).unwrap_or_default());
        }
        let mut order: Vec<(String, usize)> = Vec::new();
        fn walk(id: &str, depth: usize, kids: &HashMap<String, Vec<String>>, order: &mut Vec<(String, usize)>) {
            order.push((id.to_string(), depth));
            for k in kids.get(id).into_iter().flatten() {
                walk(k, depth + 1, kids, order);
            }
        }
        for c in cats {
            walk(&format!("minecraft:{c}/root"), 0, &kids, &mut order);
        }
        for (id, depth) in order {
            let Some(a) = all.get(&id) else { continue };
            let d = &a.j["display"];
            let cat = id.trim_start_matches("minecraft:").split('/').next().unwrap_or("story").to_string();
            let frame = d.get("frame").and_then(|v| v.as_str()).unwrap_or("task").to_string();
            let hidden = d.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
            let icon = d.pointer("/icon/id").or_else(|| d.pointer("/icon/item")).and_then(|v| v.as_str()).unwrap_or("minecraft:book").trim_start_matches("minecraft:").to_string();
            let mine = adv.get(&id);
            let done = mine.and_then(|m| m.get("done")).and_then(|v| v.as_bool()).unwrap_or(false);
            let have: HashSet<String> = mine.and_then(|m| m.get("criteria")).and_then(|c| c.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default();
            let reqs: Vec<Vec<String>> = match a.j.get("requirements").and_then(|r| r.as_array()) {
                Some(r) => r.iter().map(|g| g.as_array().map(|g| g.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()).collect(),
                None => a.j.get("criteria").and_then(|c| c.as_object()).map(|o| o.keys().map(|k| vec![k.clone()]).collect()).unwrap_or_default(),
            };
            let need = reqs.len().max(1);
            let got = if done { need } else { reqs.iter().filter(|g| g.iter().any(|c| have.contains(c))).count() };
            let t = criteria_dates(&adv, &id).values().copied().max();
            let key = format!("adv:{id}");
            if done {
                unlocked_keys.push((key.clone(), t));
            }
            let is_root = id.ends_with("/root");
            let rarity = match frame.as_str() {
                "challenge" => "legendary",
                "goal" => "epic",
                _ if is_root => "common",
                _ => match cat.as_str() {
                    "end" => "rare",
                    "story" => "common",
                    _ => "uncommon",
                },
            };
            let desc = text(&d["description"]);
            out_advs.push(json!({
                "key": key, "id": id, "name": text(&d["title"]), "desc": if hidden && !done { String::new() } else { desc },
                "group": cat, "rarity": rarity, "frame": frame, "hidden": hidden, "icon": icon, "depth": depth,
                "unlocked": done, "got": got, "need": need,
            }));
        }
    }

    // ---------------- music discs
    let mut held: HashSet<String> = HashSet::new();
    {
        fn walk(items: &[mcworld::Item], m: &mut HashSet<String>) {
            for i in items {
                if i.id.contains("music_disc_") {
                    m.insert(i.id.clone());
                }
                walk(&i.contents, m);
            }
        }
        if let Some((_, p)) = ctx.world.players().into_iter().next() {
            walk(&mcworld::items::items_of(p.get_list("Inventory")), &mut held);
            walk(&mcworld::items::items_of(p.get_list("EnderItems")), &mut held);
        }
        if let Some(ix) = ctx.index.read().clone() {
            for c in &ix.containers {
                walk(&c.items, &mut held);
            }
        }
    }
    const DISC_ORDER: &[&str] = &["13", "cat", "blocks", "chirp", "far", "mall", "mellohi", "stal", "strad", "ward", "11", "wait", "otherside", "5", "pigstep", "relic", "creator", "creator_music_box", "precipice", "tears", "lava_chicken"];
    let mut songs: Vec<String> = assets
        .jar
        .list("data/minecraft/jukebox_song/")
        .filter_map(|p| p.strip_prefix("data/minecraft/jukebox_song/").and_then(|s| s.strip_suffix(".json")).map(|s| s.to_string()))
        .filter(|s| lang.map.contains_key(&format!("item.minecraft.music_disc_{s}")))
        .collect();
    songs.sort_by_key(|s| (DISC_ORDER.iter().position(|o| o == s).unwrap_or(999), s.clone()));
    let mut out_discs = Vec::new();
    for s in &songs {
        let id = format!("minecraft:music_disc_{s}");
        let key = format!("disc:{id}");
        let got = stat("picked_up", &id) + stat("crafted", &id) + stat("used", &id) > 0 || held.contains(&id);
        if got {
            unlocked_keys.push((key.clone(), None));
        }
        let full = lang.get(&format!("jukebox_song.minecraft.{s}")).unwrap_or(s).to_string();
        let (artist, track) = full.split_once(" - ").map(|(a, t)| (a.to_string(), t.to_string())).unwrap_or((String::new(), full.clone()));
        let song = assets.jar.json(&format!("data/minecraft/jukebox_song/{s}.json"));
        let rarity = match s.as_str() {
            "13" | "cat" => "common",
            "5" | "tears" | "lava_chicken" => "epic",
            "pigstep" | "otherside" | "relic" | "creator" | "creator_music_box" | "precipice" => "rare",
            _ => "uncommon",
        };
        out_discs.push(json!({
            "key": key, "id": id, "song": s, "name": track, "artist": artist, "rarity": rarity,
            "group": if artist == "C418" { "c418" } else { "new" },
            "unlocked": got, "played": stat("used", &id), "held": held.contains(&id),
            "seconds": song.as_ref().and_then(|j| j.get("length_in_seconds")).and_then(|v| v.as_f64()).unwrap_or(0.0),
        }));
    }

    // ---------------- rare variants
    let mut out_vars = Vec::new();
    for (k, mob, name, rarity) in mcworld::variants::RARE_VARIANTS {
        let key = format!("variant:{k}");
        let sighted = sightings.get(&key);
        let tamed = pets_now.iter().any(|p| p.var == Some(*k));
        let unlocked = sighted.is_some() || variants_seen.contains(k) || tamed;
        if unlocked {
            unlocked_keys.push((key.clone(), sighted.map(|s| s.t)));
        }
        let group = if k.contains("jockey") || k.contains("horseman") {
            "riders"
        } else if matches!(*k, "charged_creeper" | "patrol_captain" | "trident_drowned") {
            "special"
        } else {
            "colors"
        };
        out_vars.push(json!({
            "key": key, "id": k, "mob": format!("minecraft:{mob}"), "name": name, "rarity": rarity, "group": group,
            "unlocked": unlocked, "how": if tamed { "tamed" } else { "seen" },
            "seen_times": sighted.map(|s| s.n).unwrap_or(0),
        }));
    }

    // ---------------- milestone plaques
    let custom = |k: &str| stat("custom", &format!("minecraft:{k}"));
    let sum_cat = |cat: &str, keep: &dyn Fn(&str) -> bool| -> i64 {
        st.pointer(&format!("/stats/minecraft:{cat}")).and_then(|o| o.as_object()).map(|o| o.iter().filter(|(k, _)| keep(k)).filter_map(|(_, v)| v.as_i64()).sum()).unwrap_or(0)
    };
    let is_block = |k: &str| lang.map.contains_key(&format!("block.minecraft.{}", k.trim_start_matches("minecraft:")));
    let walked = ["walk_one_cm", "sprint_one_cm", "crouch_one_cm", "walk_on_water_one_cm", "walk_under_water_one_cm", "swim_one_cm", "climb_one_cm"].iter().map(|k| custom(k)).sum::<i64>() / 100;
    let tracks: Vec<(&str, &str, &str, &str, i64, &[i64])> = vec![
        ("diamonds", "Diamond", "Diamonds", "diamond", stat("mined", "minecraft:diamond_ore") + stat("mined", "minecraft:deepslate_diamond_ore"), &[1, 10, 100, 500, 1000]),
        ("debris", "Ancient Debris", "Ancient Debris", "ancient_debris", stat("mined", "minecraft:ancient_debris"), &[1, 16, 64, 256]),
        ("kills", "Mob defeated", "Mobs defeated", "iron_sword", custom("mob_kills"), &[100, 1000, 10000, 100000]),
        ("zombies", "Zombie", "Zombies", "rotten_flesh", stat("killed", "minecraft:zombie"), &[10, 100, 1000, 10000]),
        ("creepers", "Creeper", "Creepers", "gunpowder", stat("killed", "minecraft:creeper"), &[10, 100, 1000]),
        ("placed", "Block placed", "Blocks placed", "bricks", sum_cat("used", &is_block), &[1000, 10000, 100000, 1000000]),
        ("mined", "Block mined", "Blocks mined", "iron_pickaxe", sum_cat("mined", &|_| true), &[1000, 10000, 100000, 1000000]),
        ("walked", "Block walked", "Blocks walked", "leather_boots", walked, &[10000, 100000, 1000000, 10000000]),
        ("flown", "Block flown", "Blocks flown", "elytra", custom("aviate_one_cm") / 100, &[10000, 100000, 1000000]),
        ("hours", "Hour played", "Hours played", "clock", custom("play_time") / 72000, &[10, 100, 500, 1000]),
        ("days", "Day", "Days in this world", "sunflower", now_day as i64, &[100, 365, 1000, 2000]),
        ("deaths", "Death", "Deaths", "bone", custom("deaths"), &[1, 10, 100]),
        ("jumps", "Jump", "Jumps", "rabbit_foot", custom("jump"), &[1000, 10000, 100000]),
        ("fish", "Fish caught", "Fish caught", "fishing_rod", custom("fish_caught"), &[10, 100, 1000]),
        ("trades", "Trade", "Villager trades", "emerald", custom("traded_with_villager"), &[10, 100, 1000]),
        ("bred", "Animal bred", "Animals bred", "wheat", custom("animals_bred"), &[10, 100, 1000]),
        ("enchanted", "Item enchanted", "Items enchanted", "enchanting_table", custom("enchant_item"), &[1, 10, 100]),
        ("sleeps", "Night slept", "Nights slept", "lantern", custom("sleep_in_bed"), &[10, 100, 365]),
    ];
    let mut out_plaques = Vec::new();
    for (id, one, many, icon, value, tiers) in &tracks {
        let mut ts = Vec::new();
        for n in tiers.iter() {
            let key = format!("plaque:{id}:{n}");
            if value >= n {
                unlocked_keys.push((key.clone(), None));
            }
            ts.push(json!({ "key": key, "n": n, "unlocked": value >= n }));
        }
        out_plaques.push(json!({ "id": id, "one": one, "many": many, "icon": icon, "value": value, "tiers": ts }));
    }


    // ---------------- Enchant, Trim and Item dexes: anything ever owned (once found, it stays found)
    let mut own_items: HashSet<String> = HashSet::new();
    let mut own_ench: HashSet<(String, i64)> = HashSet::new();
    let mut own_trims: HashSet<(String, String)> = HashSet::new();
    {
        fn walk(items: &[mcworld::Item], oi: &mut HashSet<String>, oe: &mut HashSet<(String, i64)>, ot: &mut HashSet<(String, String)>) {
            for i in items {
                oi.insert(i.id.clone());
                for (e, l) in &i.ench {
                    oe.insert((if e.contains(':') { e.clone() } else { format!("minecraft:{e}") }, *l));
                }
                if let Some((p, m)) = &i.trim {
                    ot.insert((p.trim_start_matches("minecraft:").to_string(), m.trim_start_matches("minecraft:").to_string()));
                }
                walk(&i.contents, oi, oe, ot);
            }
        }
        if let Some((_, p)) = ctx.world.players().into_iter().next() {
            for list in ["Inventory", "EnderItems"] {
                walk(&mcworld::items::items_of(p.get_list(list)), &mut own_items, &mut own_ench, &mut own_trims);
            }
            // 1.21.5+ keeps worn armour and the offhand in "equipment"
            if let Some(eq) = p.get("equipment").and_then(|e| e.compound()) {
                let worn: Vec<mcworld::Item> = eq.values().filter_map(mcworld::items::item_of).collect();
                walk(&worn, &mut own_items, &mut own_ench, &mut own_trims);
            }
        }
        if let Some(ix) = ctx.index.read().clone() {
            for c in &ix.containers {
                walk(&c.items, &mut own_items, &mut own_ench, &mut own_trims);
            }
        }
    }
    let ever = |key: &str| state.first.contains_key(key) || state.before.contains(key);
    let rank_name = |r: usize| ["common", "uncommon", "rare", "epic", "legendary"][r.min(4)];

    // enchantments, one card per level
    let treasure: HashSet<String> = assets
        .jar
        .json("data/minecraft/tags/enchantment/treasure.json")
        .and_then(|j| j["values"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim_start_matches("minecraft:").to_string()))
        .collect();
    let mut ench_ids: Vec<String> = assets
        .jar
        .list("data/minecraft/enchantment/")
        .filter_map(|p| p.strip_prefix("data/minecraft/enchantment/").and_then(|s| s.strip_suffix(".json")).map(|s| s.to_string()))
        .filter(|s| !s.contains('/'))
        .collect();
    ench_ids.sort();
    let mut out_ench = Vec::new();
    for e in &ench_ids {
        let Some(j) = assets.jar.json(&format!("data/minecraft/enchantment/{e}.json")) else { continue };
        let max = j["max_level"].as_i64().unwrap_or(1).max(1);
        let weight = j["weight"].as_i64().unwrap_or(5);
        let tag = j["supported_items"].as_str().unwrap_or("").to_string();
        let group = enchant_group(e, &tag);
        let id = format!("minecraft:{e}");
        let base = lang.map.get(&format!("enchantment.minecraft.{e}")).cloned().unwrap_or_else(|| lang.name(&id));
        let curse = e.contains("curse");
        let base_rank: usize = if curse {
            1
        } else if treasure.contains(e) {
            3
        } else {
            match weight {
                w if w >= 10 => 0,
                w if w >= 5 => 1,
                w if w >= 2 => 2,
                _ => 3,
            }
        };
        for lvl in 1..=max {
            let key = format!("ench:{id}:{lvl}");
            let copies = own_ench.iter().filter(|(x, l)| x == &id && *l == lvl).count();
            let have = copies > 0;
            let unlocked = have || ever(&key);
            if unlocked {
                unlocked_keys.push((key.clone(), None));
            }
            let r = base_rank + usize::from(max > 1 && lvl == max && !curse);
            out_ench.push(json!({
                "key": key, "id": id, "name": if max > 1 { format!("{base} {}", roman(lvl)) } else { base.clone() },
                "group": group, "rarity": rank_name(r), "unlocked": unlocked,
                "level": lvl, "max": max, "have": have, "copies": copies, "treasure": treasure.contains(e), "curse": curse, "weight": weight,
            }));
        }
    }

    // armour trims: every pattern in every material
    let strip = |s: String, tail: &str| s.strip_suffix(tail).map(|x| x.to_string()).unwrap_or(s);
    let list_ids = |dir: &str| -> Vec<String> {
        let mut v: Vec<String> = assets.jar.list(dir).filter_map(|p| p.strip_prefix(dir).and_then(|s| s.strip_suffix(".json")).map(|s| s.to_string())).collect();
        v.sort();
        v
    };
    const PATTERN_ORDER: &[&str] = &["sentry", "dune", "coast", "wild", "tide", "ward", "vex", "rib", "snout", "eye", "spire", "silence", "wayfinder", "shaper", "raiser", "host", "flow", "bolt"];
    let mut patterns = list_ids("data/minecraft/trim_pattern/");
    patterns.sort_by_key(|p| (PATTERN_ORDER.iter().position(|o| o == p).unwrap_or(99), p.clone()));
    const MATERIAL_ORDER: &[&str] = &["quartz", "iron", "netherite", "redstone", "copper", "gold", "emerald", "diamond", "lapis", "amethyst", "resin"];
    let mut materials = list_ids("data/minecraft/trim_material/");
    materials.sort_by_key(|m| (MATERIAL_ORDER.iter().position(|o| o == m).unwrap_or(99), m.clone()));
    let mut out_trims = Vec::new();
    for p in &patterns {
        let pj = assets.jar.json(&format!("data/minecraft/trim_pattern/{p}.json")).unwrap_or(Value::Null);
        let pname = strip(lang.map.get(&format!("trim_pattern.minecraft.{p}")).cloned().unwrap_or_else(|| lang.name(p)), " Armor Trim");
        let pr: usize = match p.as_str() {
            "silence" => 4,
            "eye" | "ward" | "vex" | "spire" | "rib" => 3,
            "sentry" | "dune" | "coast" | "wild" | "snout" | "tide" => 1,
            _ => 2,
        };
        for m in &materials {
            let mj = assets.jar.json(&format!("data/minecraft/trim_material/{m}.json")).unwrap_or(Value::Null);
            let mname = strip(lang.map.get(&format!("trim_material.minecraft.{m}")).cloned().unwrap_or_else(|| lang.name(m)), " Material");
            let key = format!("trim:{p}:{m}");
            let have = own_trims.contains(&(p.clone(), m.clone()));
            let unlocked = have || ever(&key);
            if unlocked {
                unlocked_keys.push((key.clone(), None));
            }
            let mr = usize::from(matches!(m.as_str(), "netherite" | "diamond" | "amethyst"));
            out_trims.push(json!({
                "key": key, "id": format!("minecraft:{p}_armor_trim_smithing_template"), "name": format!("{pname} in {mname}"),
                "pattern": p, "material": m, "pattern_name": pname, "material_name": mname,
                "color": mj["description"]["color"].as_str().unwrap_or("#cccccc"), "decal": pj["decal"].as_bool().unwrap_or(false),
                "group": p, "rarity": rank_name((pr + mr).min(4)), "unlocked": unlocked, "have": have,
            }));
        }
    }

    // every item that isn't a block (blocks and discs have their own dexes)
    let mut item_ids: Vec<String> = assets
        .jar
        .list("items/")
        .filter_map(|p| p.strip_prefix("items/").and_then(|s| s.strip_suffix(".json")).map(|s| s.to_string()))
        .filter(|id| lang.map.contains_key(&format!("item.minecraft.{id}")) && !lang.map.contains_key(&format!("block.minecraft.{id}")) && !item_excluded(id))
        .collect();
    item_ids.sort();
    let mut out_items = Vec::new();
    for i in &item_ids {
        let id = format!("minecraft:{i}");
        let key = format!("item:{id}");
        let picked = stat("picked_up", &id);
        let crafted = stat("crafted", &id);
        let used = stat("used", &id);
        let broken = stat("broken", &id);
        let have = own_items.contains(&id);
        let unlocked = have || picked > 0 || crafted > 0 || used > 0 || broken > 0 || ever(&key);
        if unlocked {
            unlocked_keys.push((key.clone(), None));
        }
        out_items.push(json!({
            "key": key, "id": id, "name": lang.name(&id), "group": item_group(i), "rarity": item_rarity(i),
            "unlocked": unlocked, "have": have, "picked": picked, "crafted": crafted, "used": used, "broken": broken,
        }));
    }

    // ---------------- first-unlock stamps, reveals
    if state.initialized && state.kinds.is_empty() {
        for k in ["mob", "death", "biome", "pet", "block"] {
            state.kinds.insert(k.to_string());
        }
    }
    let fresh: HashSet<&str> = ALL_KINDS.iter().copied().filter(|k| first_run || !state.kinds.contains(*k)).collect();
    for (k, known) in &unlocked_keys {
        if state.first.contains_key(k) || (state.before.contains(k) && known.is_none()) {
            if let (Some(t), Some(f)) = (known, state.first.get(k)) {
                if *t < f.t {
                    state.first.insert(k.clone(), stamp_at(*t));
                }
            }
            continue;
        }
        match known {
            Some(t) => {
                state.first.insert(k.clone(), stamp_at(*t));
            }
            None if fresh.contains(kind_of(k)) => {
                state.before.insert(k.clone());
            }
            None => {
                state.first.insert(k.clone(), Stamp { t: now, day: Some(now_day) });
            }
        }
    }
    let intro = first_run;
    // a brand-new Dex, or a collection added in an update, starts with everything already revealed
    for (k, _) in &unlocked_keys {
        if fresh.contains(kind_of(k)) {
            state.revealed.insert(k.clone());
        }
    }
    state.initialized = true;
    let new_kinds: Vec<&str> = if first_run { vec![] } else { fresh.iter().copied().filter(|k| *k != "pet").collect() };
    // the owned-item collections need the storage index; until it's built they stay "fresh" (quiet)
    let index_ready = ctx.index.read().is_some();
    for k in ALL_KINDS {
        if !index_ready && matches!(*k, "ench" | "trim" | "item") {
            continue;
        }
        state.kinds.insert(k.to_string());
    }
    let attach = |list: &mut Vec<Value>, state: &DexState| {
        for v in list.iter_mut() {
            let k = v["key"].as_str().unwrap_or("").to_string();
            let unlocked = v["unlocked"].as_bool().unwrap_or(true) || k.starts_with("pet:");
            v["first"] = state.first.get(&k).map(|s| json!(s)).unwrap_or(Value::Null);
            v["before"] = json!(state.before.contains(&k));
            v["new"] = json!(unlocked && !state.revealed.contains(&k));
        }
    };
    attach(&mut out_mobs, &state);
    attach(&mut out_deaths, &state);
    attach(&mut out_biomes, &state);
    attach(&mut out_pets, &state);
    attach(&mut out_blocks, &state);
    attach(&mut out_advs, &state);
    attach(&mut out_discs, &state);
    attach(&mut out_vars, &state);
    attach(&mut out_ench, &state);
    attach(&mut out_trims, &state);
    attach(&mut out_items, &state);
    for p in out_plaques.iter_mut() {
        if let Some(ts) = p["tiers"].as_array_mut() {
            attach(ts, &state);
        }
    }
    save_state(&ctx.dir, &state);

    // ---------------- the in-game companion's card list (names, rarities, what's unlocked)
    {
        let slim = |list: &Vec<Value>, extra: &[&str]| -> Vec<Value> {
            list.iter()
                .map(|v| {
                    let mut o = json!({ "k": v["key"], "n": v["name"], "r": v["rarity"], "g": v["group"], "i": v["id"], "u": v["unlocked"], "w": v["new"] });
                    for f in extra {
                        o[*f] = v[*f].clone();
                    }
                    o
                })
                .collect()
        };
        let mut cards = Vec::new();
        cards.extend(slim(&out_mobs, &["killed"]));
        cards.extend(slim(&out_deaths, &["count"]));
        cards.extend(slim(&out_biomes, &["tex"]));
        cards.extend(slim(&out_blocks, &[]));
        cards.extend(slim(&out_advs, &["icon", "frame"]));
        cards.extend(slim(&out_discs, &["artist"]));
        cards.extend(slim(&out_vars, &["mob", "seen_times"]));
        cards.extend(out_pets.iter().map(|v| json!({ "k": v["key"], "n": v["name"], "sp": v["species"], "r": v["rarity"], "g": "pets", "i": v["id"], "u": true, "w": v["new"] })));
        atlascore::companion::write_catalog(
            &ctx.dir,
            &json!({ "v": 1, "computed": now, "world": ctx.entry.path, "player": ctx.player_name, "uuid": uuid, "cards": cards, "plaques": out_plaques }),
        );
    }

    json!({
        "mobs": out_mobs,
        "deaths": out_deaths,
        "deaths_total": total_deaths,
        "deaths_unread": (total_deaths - matched).max(0),
        "biomes": out_biomes,
        "pets": out_pets,
        "blocks": out_blocks,
        "advancements": out_advs,
        "discs": out_discs,
        "variants": out_vars,
        "enchants": out_ench,
        "trims": out_trims,
        "items": out_items,
        "plaques": out_plaques,
        "new_kinds": new_kinds,
        "intro": intro,
        "player": ctx.player_name,
        "day": now_day,
        "computed": now,
    })
}
