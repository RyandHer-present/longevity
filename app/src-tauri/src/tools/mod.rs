//! Longevity's world tools: Villager Roster, Farm Check, Storage Doctor, Gear Check, Project
//! Planner, the Home glance, the kill board, and the file link with the in-game companion mod.
//! Everything here only READS the save. Longevity's own notes live in the world's data folder.

pub mod bridge;
pub mod doctor;
pub mod farms;
pub mod gear;
pub mod projects;
pub mod recap;
pub mod villagers;

use crate::{err, AppState, Ctx};
use mcassets::Assets;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub type R<T> = Result<T, String>;

/// Read a JSON file, or None if missing / broken.
pub fn read_json(p: &Path) -> Option<Value> {
    std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Write JSON atomically (tmp + rename) so the game never reads half a file.
pub fn write_json(p: &Path, v: &Value) -> R<()> {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, p).map_err(err)
}

pub fn now() -> i64 {
    atlascore::now_ms()
}

/// Called whenever the storage index is (re)built: refresh the files the in-game mod reads and
/// take the farm-output snapshot for the history charts.
pub fn on_index_built(ctx: &Arc<Ctx>, assets: Option<&Arc<Assets>>) {
    let Some(idx) = ctx.index.read().clone() else { return };
    bridge::write_index(ctx, &idx, assets.map(|a| a.as_ref()));
    farms::snapshot_outputs(ctx, &idx);
    if let Some(a) = assets {
        let _ = villagers::write_for_game(ctx, a);
        projects::write_for_game(ctx, a);
    }
}

/// After a play session ends: rebuild what changed, write the recap, check goals.
pub fn after_game(app: &AppHandle, instance: &str, started_ms: i64, crashed: bool) {
    let app = app.clone();
    let instance = instance.to_string();
    std::thread::spawn(move || {
        // give Minecraft a moment to finish writing the save
        std::thread::sleep(std::time::Duration::from_secs(4));
        recap::after_game(&app, &instance, started_ms, crashed);
    });
}

fn ctx_assets(state: &State<'_, AppState>) -> R<(Arc<Ctx>, Arc<Assets>)> {
    Ok((state.ctx()?, state.assets()?))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn t_villagers(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || villagers::roster(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_farms(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || farms::report(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_farm_save(state: State<'_, AppState>, farm: Value) -> R<Value> {
    let ctx = state.ctx()?;
    blocking(move || farms::save_user(&ctx, farm)).await?
}

#[tauri::command]
pub async fn t_farm_delete(state: State<'_, AppState>, id: String) -> R<()> {
    let ctx = state.ctx()?;
    blocking(move || farms::delete_user(&ctx, &id)).await?
}

#[tauri::command]
pub async fn t_doctor(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || doctor::report(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_gear(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || gear::report(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_projects(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || projects::list(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_projects_save(state: State<'_, AppState>, projects: Value) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || projects::save(&ctx, &assets, projects)).await?
}

/// Ask the game to glow some containers ("find in game").
#[tauri::command]
pub async fn t_find(state: State<'_, AppState>, label: String, targets: Vec<Value>) -> R<()> {
    let ctx = state.ctx()?;
    bridge::request_find(&ctx, &label, targets)
}

/// Start (or clear, with null) the storage cleanup glow guide in game.
#[tauri::command]
pub async fn t_guide(state: State<'_, AppState>, guide: Option<Value>) -> R<()> {
    let ctx = state.ctx()?;
    bridge::request_guide(&ctx, guide)
}

/// The latest live data from the in-game mod: position, trail, deaths (for the live map dot,
/// trail and 3D follow cam). "fresh" is false when the game isn't running this world.
#[tauri::command]
pub async fn t_live(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    Ok(bridge::live(&ctx))
}

#[tauri::command]
pub async fn t_kills(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || kill_board(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_glance(state: State<'_, AppState>) -> R<Value> {
    let (ctx, assets) = ctx_assets(&state)?;
    blocking(move || glance(&ctx, &assets)).await
}

#[tauri::command]
pub async fn t_recaps(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    Ok(recap::list(&ctx))
}

#[tauri::command]
pub async fn t_recap_seen(app: AppHandle, id: String) -> R<()> {
    recap::mark_seen(&app, &id)
}

/// The raw statistics file (mined/crafted/used/killed per id) for "your numbers".
#[tauri::command]
pub async fn t_stats_raw(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let st = ctx.player_uuid.as_ref().and_then(|u| ctx.world.stats_json(u)).and_then(|s| s.get("stats").cloned());
    Ok(st.unwrap_or(json!({})))
}

#[tauri::command]
pub async fn t_shot_tags(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    Ok(read_json(&ctx.dir.join("companion-shots.json")).unwrap_or(json!({})))
}

/// Which item stacks to how many (a good guess; the bundled game data refines it on the page).
pub fn max_stack(id: &str) -> i64 {
    let s = id.trim_start_matches("minecraft:");
    if s == "bucket" {
        return 16;
    }
    let ones = [
        "sword", "pickaxe", "_axe", "shovel", "_hoe", "helmet", "chestplate", "leggings", "boots", "bow", "crossbow", "trident", "shield", "elytra", "mace", "spear", "fishing_rod",
        "flint_and_steel", "shears", "potion", "_bucket", "saddle", "minecart", "_boat", "_raft", "_bed", "shulker_box", "totem_of_undying", "music_disc", "enchanted_book", "writable_book",
        "written_book", "horse_armor", "bundle", "brush", "spyglass", "goat_horn", "_stew", "_soup", "cake", "carrot_on_a_stick", "warped_fungus_on_a_stick", "knowledge_book", "wolf_armor", "harness",
    ];
    if ones.iter().any(|k| s.ends_with(k) || s.starts_with(k)) {
        return 1;
    }
    let sixteen = ["ender_pearl", "snowball", "egg", "_sign", "banner", "honey_bottle", "armor_stand", "bucket"];
    if sixteen.iter().any(|k| s.ends_with(k)) {
        return 16;
    }
    64
}

pub fn slots_of(kind: &str) -> i64 {
    let s = kind.trim_start_matches("minecraft:");
    match s {
        "hopper" | "hopper_minecart" => 5,
        "dispenser" | "dropper" | "crafter" => 9,
        "furnace" | "blast_furnace" | "smoker" => 3,
        "brewing_stand" => 5,
        "player:inventory" => 41,
        _ => 27,
    }
}

// ---------------------------------------------------------------- kill board

fn kill_board(ctx: &Ctx, assets: &Assets) -> Value {
    let empty = json!({ "killed": [], "killed_by": [] });
    let Some(uuid) = ctx.player_uuid.clone() else { return empty };
    let Some(st) = ctx.world.stats_json(&uuid) else { return empty };
    let stats = st.get("stats").cloned().unwrap_or(json!({}));
    let list = |key: &str| -> Vec<Value> {
        let mut v: Vec<(String, i64)> = stats.get(key).and_then(|m| m.as_object()).map(|m| m.iter().map(|(k, n)| (k.clone(), n.as_i64().unwrap_or(0))).collect()).unwrap_or_default();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        // mob names, not the item with the same id ("Salmon", not "Raw Salmon")
        v.into_iter().map(|(id, n)| json!({ "id": id, "name": assets.lang.entity_name(&id), "count": n })).collect()
    };
    let custom = stats.get("minecraft:custom").cloned().unwrap_or(json!({}));
    let c = |k: &str| custom.get(k).cloned().unwrap_or(json!(0));
    json!({
        "killed": list("minecraft:killed"),
        "killed_by": list("minecraft:killed_by"),
        "mob_kills": c("minecraft:mob_kills"),
        "player_kills": c("minecraft:player_kills"),
        "deaths": c("minecraft:deaths"),
        "damage_dealt": c("minecraft:damage_dealt"),
        "damage_taken": c("minecraft:damage_taken"),
    })
}

// ---------------------------------------------------------------- Home glance

fn glance(ctx: &Arc<Ctx>, assets: &Arc<Assets>) -> Value {
    let level = ctx.world.level().ok();
    let play_ticks = ctx
        .player_uuid
        .as_ref()
        .and_then(|u| ctx.world.stats_json(u))
        .and_then(|s| s.pointer("/stats/minecraft:custom/minecraft:play_time").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let farms = farms::report(ctx, assets);
    // "maybe" farms (wild cane, village fields) don't count until you say they're yours
    let mine: Vec<Value> = farms.get("farms").and_then(|v| v.as_array()).cloned().unwrap_or_default().into_iter().filter(|f| !f["maybe"].as_bool().unwrap_or(false)).collect();
    let mut per_hour: std::collections::HashMap<String, f64> = Default::default();
    for f in mine.iter().cloned() {
        if let Some(m) = f.pointer("/rate/per_hour").and_then(|v| v.as_object()) {
            for (k, v) in m {
                *per_hour.entry(k.clone()).or_default() += v.as_f64().unwrap_or(0.0);
            }
        }
    }
    let mut top: Vec<(String, f64)> = per_hour.into_iter().collect();
    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    top.truncate(4);
    let projects = projects::list(ctx, assets);
    json!({
        "day": level.as_ref().map(|l| l.day()).unwrap_or(0),
        "play_ticks": play_ticks,
        "farm_count": mine.len(),
        "farm_top": top.iter().map(|(id, n)| json!({ "id": id, "name": assets.lang.name(id), "per_hour": n.round() })).collect::<Vec<_>>(),
        "projects": projects.get("projects").cloned().unwrap_or(json!([])),
    })
}
