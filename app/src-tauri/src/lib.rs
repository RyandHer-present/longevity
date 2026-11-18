//! Longevity backend.

mod app;
mod import;
mod tools;
mod dex;
pub mod launcher;
pub mod explore;
mod places;
mod search;
mod sounds;
mod stats;
mod tiles;
mod packview;
mod update;
mod view;
mod walk;

use atlascore::events::Event;
use atlascore::lore::Place;
use explore::Explored;
use mcassets::Assets;
use mcworld::nbt::{Value as Nbt, V};
use mcworld::{Dim, World, WorldEntry};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub struct Ctx {
    pub entry: WorldEntry,
    pub world: World,
    pub dir: PathBuf,
    pub explored: RwLock<HashMap<Dim, Arc<Explored>>>,
    pub index: RwLock<Option<Arc<search::Index>>>,
    pub player_name: String,
    pub player_uuid: Option<String>,
    pub sessions: RwLock<Option<Arc<Vec<atlascore::logs::Session>>>>,
}

#[derive(Default)]
pub struct AppState {
    pub assets: RwLock<Option<Arc<Assets>>>,
    pub assets_err: RwLock<Option<String>>,
    pub world: RwLock<Option<Arc<Ctx>>>,
    /// A Time Capsule being viewed in 3D (replaces the world for the 3D/map views while set).
    capsule: RwLock<Option<(String, Arc<Ctx>)>>,
    capturing: Mutex<bool>,
    icons: Mutex<HashMap<String, Vec<u8>>>,
    writing: Mutex<bool>,
}

impl AppState {
    fn assets(&self) -> R<Arc<Assets>> {
        for _ in 0..600 {
            if let Some(a) = self.assets.read().clone() {
                return Ok(a);
            }
            if let Some(e) = self.assets_err.read().clone() {
                return Err(e);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("Minecraft assets are still loading".into())
    }
    /// Empty the world readers' caches (the real world and an open Time Capsule).
    pub fn trim_caches(&self) {
        if let Some(c) = self.world.read().as_ref() {
            c.world.trim();
        }
        if let Some((_, c)) = self.capsule.read().as_ref() {
            c.world.trim();
        }
        self.icons.lock().clear();
    }
    fn ctx(&self) -> R<Arc<Ctx>> {
        self.world.read().clone().ok_or_else(|| "No world open".to_string())
    }
    /// The world the 3D view shows: a Time Capsule when one is open, else the real world.
    fn view(&self) -> R<Arc<Ctx>> {
        if let Some((_, c)) = self.capsule.read().as_ref() {
            return Ok(c.clone());
        }
        self.ctx()
    }
}

impl Ctx {
    fn explored(&self, dim: Dim) -> Arc<Explored> {
        if let Some(e) = self.explored.read().get(&dim) {
            return e.clone();
        }
        let e = Arc::new(explore::explore(&self.world, dim, &self.dir));
        self.explored.write().insert(dim, e.clone());
        e
    }
    fn refresh_explored(&self, dim: Dim) -> Arc<Explored> {
        let e = Arc::new(explore::explore(&self.world, dim, &self.dir));
        self.explored.write().insert(dim, e.clone());
        e
    }
    /// Re-read the explored map of every dimension and rebuild the storage index.
    pub(crate) fn rebuild_index(&self) {
        let mut seen = HashMap::new();
        for d in Dim::all() {
            seen.insert(d, self.refresh_explored(d).seen.clone());
        }
        *self.index.write() = Some(Arc::new(search::build(&self.world, &seen)));
    }
    fn instance_dir(&self) -> Option<PathBuf> {
        // .../<instance>/minecraft/saves/<world>
        self.entry.path.parent()?.parent().map(|p| p.to_path_buf())
    }
    fn sessions(&self, assets: &Assets) -> Arc<Vec<atlascore::logs::Session>> {
        if let Some(s) = self.sessions.read().clone() {
            return s;
        }
        let Some(inst) = self.instance_dir() else { return Arc::new(vec![]) };
        let templates: Vec<String> = assets.lang.death_patterns().into_iter().map(|d| d.template).collect();
        let all = atlascore::logs::parse_sessions(&inst.join("logs"), &templates);
        let level = self.world.level().map(|l| l.name).unwrap_or_default();
        let ex = self.explored(Dim::Overworld);
        let exn = self.explored(Dim::Nether);
        let visited = |x: f64, z: f64| {
            let c = ((x.floor() as i32) >> 4, (z.floor() as i32) >> 4);
            ex.visited.contains_key(&c) || exn.visited.contains_key(&c)
        };
        let s = Arc::new(stats::sessions_for_world(&all, &level, &visited));
        *self.sessions.write() = Some(s.clone());
        s
    }
}

fn dim_of(s: &str) -> Dim {
    Dim::from_id(s).unwrap_or(Dim::Overworld)
}

fn player_name(world_path: &Path, uuid: Option<&str>) -> String {
    // usercache.json lives in the instance's minecraft folder
    let inst = world_path.parent().and_then(|p| p.parent());
    if let (Some(inst), Some(uuid)) = (inst, uuid) {
        if let Ok(text) = std::fs::read_to_string(inst.join("usercache.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(a) = v.as_array() {
                    for e in a {
                        if e.get("uuid").and_then(|u| u.as_str()) == Some(uuid) {
                            if let Some(n) = e.get("name").and_then(|n| n.as_str()) {
                                return n.to_string();
                            }
                        }
                    }
                }
            }
        }
    }
    "Player".into()
}

// ---------------------------------------------------------------- worlds

#[derive(Serialize)]
struct WorldListItem {
    path: String,
    folder: String,
    name: String,
    instance: String,
    source: String,
    version: String,
    last_played: i64,
    size: u64,
    icon: Option<String>,
}

#[tauri::command]
async fn list_worlds() -> R<Vec<WorldListItem>> {
    tauri::async_runtime::spawn_blocking(|| {
        mcworld::world::discover()
            .into_iter()
            .map(|w| WorldListItem {
                path: w.path.to_string_lossy().to_string(),
                folder: w.folder.clone(),
                name: w.name.clone(),
                instance: w.instance.clone(),
                source: w.source.clone(),
                version: w.version.clone(),
                last_played: w.last_played,
                size: w.size_bytes,
                icon: w.icon.as_ref().and_then(|p| std::fs::read(p).ok()).map(|b| format!("data:image/png;base64,{}", base64_encode(&b))),
            })
            .collect()
    })
    .await
    .map_err(err)
}

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn player_json(p: &Nbt, assets: Option<&Assets>) -> Value {
    let pos = p.get_list("Pos");
    let rot = p.get_list("Rotation");
    let f = |l: &[Nbt], i: usize| l.get(i).and_then(|v| v.f64()).unwrap_or(0.0);
    let respawn = p.get("respawn").map(|r| {
        json!({ "pos": r.get("pos").and_then(|v| v.int_array()), "dim": r.get_str("dimension") })
    });
    let last_death = p.get("LastDeathLocation").map(|r| json!({ "pos": r.get("pos").and_then(|v| v.int_array()), "dim": r.get_str("dimension") }));
    let hand = p.get_list("Inventory").iter().find(|i| i.get_i64("Slot") == Some(p.get_i64("SelectedItemSlot").unwrap_or(0))).and_then(mcworld::items::item_of);
    json!({
        "pos": [f(pos, 0), f(pos, 1), f(pos, 2)],
        "yaw": f(rot, 0), "pitch": f(rot, 1),
        "dim": p.get_str("Dimension").unwrap_or("minecraft:overworld"),
        "health": p.get_f64("Health").unwrap_or(20.0),
        "food": p.get_i64("foodLevel").unwrap_or(20),
        "xp_level": p.get_i64("XpLevel").unwrap_or(0),
        "xp_total": p.get_i64("XpTotal").unwrap_or(0),
        "game_type": p.get_i64("playerGameType").unwrap_or(0),
        "respawn": respawn,
        "last_death": last_death,
        "hand": hand.map(|h| json!({"id": h.id, "name": assets.map(|a| a.lang.name(&h.id))})),
    })
}

fn summary_of(ctx: &Ctx, assets: Option<&Assets>) -> Value {
    let level = ctx.world.level().ok();
    let players: Vec<Value> = ctx.world.players().iter().map(|(_, p)| player_json(p, assets)).collect();
    let dims: Vec<Value> = Dim::all().iter().map(|d| json!({ "id": d.id(), "regions": ctx.world.regions(*d).len() })).collect();
    json!({
        "id": atlascore::world_id(&ctx.entry.path),
        "path": ctx.entry.path,
        "folder": ctx.entry.folder,
        "instance": ctx.entry.instance,
        "name": level.as_ref().map(|l| l.name.clone()).unwrap_or_default(),
        "version": level.as_ref().map(|l| l.version.clone()).unwrap_or_default(),
        "day": level.as_ref().map(|l| l.day()).unwrap_or(0),
        "day_time": level.as_ref().map(|l| l.day_time).unwrap_or(0),
        "time": level.as_ref().map(|l| l.time).unwrap_or(0),
        "hardcore": level.as_ref().map(|l| l.hardcore).unwrap_or(false),
        "difficulty": level.as_ref().map(|l| l.difficulty).unwrap_or(2),
        "raining": level.as_ref().map(|l| l.raining).unwrap_or(false),
        "thundering": level.as_ref().map(|l| l.thundering).unwrap_or(false),
        "spawn": level.as_ref().and_then(|l| l.spawn),
        "last_played": level.as_ref().map(|l| l.last_played).unwrap_or(0),
        "player": ctx.player_name,
        "players": players,
        "dims": dims,
        "open": ctx.world.is_open_in_game(),
        "size": ctx.entry.size_bytes,
    })
}

#[tauri::command]
async fn open_world(state: State<'_, AppState>, path: String) -> R<Value> {
    let ctx = make_ctx(Path::new(&path))?;
    *state.world.write() = Some(ctx.clone());
    let mut s = atlascore::Settings::load();
    s.last_world = Some(path);
    let _ = s.save();
    let assets = state.assets.read().clone();
    let c2 = ctx.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        c2.explored(Dim::Overworld);
        summary_of(&c2, assets.as_deref())
    })
    .await
    .map_err(err)?;
    // build the storage index (and the files the in-game mod reads) in the background
    let c3 = ctx.clone();
    let a3 = state.assets.read().clone();
    std::thread::spawn(move || {
        c3.rebuild_index();
        tools::on_index_built(&c3, a3.as_ref());
    });
    Ok(out)
}

/// Open a world save as a fresh context (nothing cached yet).
pub(crate) fn make_ctx(path: &Path) -> R<Arc<Ctx>> {
    let entry = mcworld::world::discover().into_iter().find(|w| w.path == path || w.path.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy())).ok_or("World not found")?;
    let world = World::open(&entry.path).map_err(err)?;
    let dir = atlascore::world_dir(&entry.path);
    let uuid = world.players().first().map(|(u, _)| u.clone());
    let name = player_name(&entry.path, uuid.as_deref());
    Ok(Arc::new(Ctx { entry, world, dir, explored: RwLock::new(HashMap::new()), index: RwLock::new(None), player_name: name, player_uuid: uuid, sessions: RwLock::new(None) }))
}

#[tauri::command]
async fn world_summary(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets.read().clone();
    tauri::async_runtime::spawn_blocking(move || summary_of(&ctx, assets.as_deref())).await.map_err(err)
}

#[tauri::command]
async fn app_info(state: State<'_, AppState>) -> R<Value> {
    let ready = state.assets.read().is_some();
    let version = state.assets.read().as_ref().map(|a| a.version.clone());
    Ok(json!({
        "assets_ready": ready,
        "assets_error": state.assets_err.read().clone(),
        "mc_version": version,
        "ai": atlascore::ai::status(),
        "settings": atlascore::Settings::load(),
        "app_version": env!("CARGO_PKG_VERSION"),
        // test-only: a comma list of pages to step through, e.g. "home,map,world"
        "test_tour": std::env::var("ATLAS_TEST_TOUR").ok(),
        "test_interval": std::env::var("ATLAS_TEST_INTERVAL").ok().and_then(|v| v.parse::<u64>().ok()),
    }))
}

#[tauri::command]
fn settings_set(settings: atlascore::Settings) -> R<()> {
    settings.save().map_err(err)
}

// ---------------------------------------------------------------- explore / render

#[tauri::command]
async fn explored(state: State<'_, AppState>, dim: String) -> R<Value> {
    let ctx = state.view()?;
    tauri::async_runtime::spawn_blocking(move || {
        let e = ctx.explored(dim_of(&dim));
        let mut visited: Vec<i64> = Vec::with_capacity(e.visited.len() * 3);
        for (&(x, z), &t) in &e.visited {
            visited.extend_from_slice(&[x as i64, z as i64, t]);
        }
        let structures: Vec<Value> = e.structures.iter().map(|s| json!({ "id": s.id, "bbox": s.bbox })).collect();
        json!({
            "visited": visited,
            "seen": e.seen.len(),
            "generated": e.generated,
            "regions": e.regions,
            "structures": structures,
        })
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn textures(state: State<'_, AppState>) -> R<tauri::ipc::Response> {
    let assets = state.assets()?;
    let tex = assets.tex.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let anim = tex.anim_table();
        let rgba = tex.rgba();
        let layers = (rgba.len() / 1024) as u32;
        let mut out = Vec::with_capacity(8 + anim.len() * 4 + rgba.len());
        out.extend_from_slice(&layers.to_le_bytes());
        out.extend_from_slice(&(anim.len() as u32).to_le_bytes());
        for a in &anim {
            out.extend_from_slice(&a[0].to_le_bytes());
            out.extend_from_slice(&a[1].to_le_bytes());
        }
        out.extend_from_slice(&rgba);
        out
    })
    .await
    .map_err(err)?;
    Ok(tauri::ipc::Response::new(out))
}

/// Mesh a batch of chunks. Each entry is [cx, cz, near] where near=1 keeps dark interiors (caves around the camera).
#[tauri::command]
async fn mesh(state: State<'_, AppState>, dim: String, chunks: Vec<[i32; 3]>, ycut: Option<i32>) -> R<tauri::ipc::Response> {
    let ctx = state.view()?;
    let assets = state.assets()?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        let dim_key = dim.clone();
        let dim = dim_of(&dim);
        let e = ctx.explored(dim);
        let mut need: HashSet<(i32, i32)> = HashSet::new();
        for c in &chunks {
            for dz in -1..=1 {
                for dx in -1..=1 {
                    need.insert((c[0] + dx, c[1] + dz));
                }
            }
        }
        let loaded: Vec<((i32, i32), Option<Arc<mcworld::Chunk>>)> = need.par_iter().map(|&(x, z)| ((x, z), ctx.world.chunk(dim, x, z))).collect();
        let mut map = HashMap::new();
        let mut hidden = HashMap::new();
        for (k, c) in loaded {
            let Some(c) = c else { continue };
            if e.seen.contains(&k) {
                map.insert(k, c);
            } else {
                let top = c.surface.as_ref().map(|s| *s.iter().max().unwrap_or(&64)).unwrap_or(64);
                hidden.insert(k, top);
            }
        }
        let range = (dim.min_y() >> 4, (dim.max_y() >> 4).max(dim.min_y() >> 4));
        let patched = walk::patched_sections(&dim_key, &map);
        let v = view::View { chunks: map, hidden, range, patched };
        let meshes: Vec<Vec<u8>> = chunks
            .par_iter()
            .map(|c| {
                if !e.seen.contains(&(c[0], c[1])) || !v.chunks.contains_key(&(c[0], c[1])) {
                    let empty = mesher::ChunkMesh { cx: c[0], cz: c[1], ..Default::default() };
                    return empty.to_bytes();
                }
                let opts = mesher::MeshOptions { skip_dark: c[2] == 0, min_y: -100000, max_y: ycut.unwrap_or(100000) };
                mesher::mesh_chunk(&v, &assets, c[0], c[1], &opts).to_bytes()
            })
            .collect();
        let layers = assets.tex.layer_count() as u32;
        let mut out = Vec::with_capacity(8 + meshes.iter().map(|m| m.len() + 4).sum::<usize>());
        out.extend_from_slice(&layers.to_le_bytes());
        out.extend_from_slice(&(meshes.len() as u32).to_le_bytes());
        for m in meshes {
            out.extend_from_slice(&(m.len() as u32).to_le_bytes());
            out.extend_from_slice(&m);
        }
        out
    })
    .await
    .map_err(err)?;
    Ok(tauri::ipc::Response::new(out))
}

/// 32x32x32 solidity bits around a point (for camera collision). Bit order: x fastest, then z, then y.
#[tauri::command]
async fn solid_box(state: State<'_, AppState>, dim: String, x: i32, y: i32, z: i32) -> R<tauri::ipc::Response> {
    let ctx = state.view()?;
    let assets = state.assets()?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let dim = dim_of(&dim);
        let e = ctx.explored(dim);
        let (x0, y0, z0) = (x - 16, y - 16, z - 16);
        let mut bits = vec![0u8; 32 * 32 * 32 / 8];
        for cz in (z0 >> 4)..=((z0 + 31) >> 4) {
            for cx in (x0 >> 4)..=((x0 + 31) >> 4) {
                let unseen = !e.seen.contains(&(cx, cz));
                let chunk = ctx.world.chunk(dim, cx, cz);
                for lz in 0..16 {
                    for lx in 0..16 {
                        let wx = cx * 16 + lx;
                        let wz = cz * 16 + lz;
                        if wx < x0 || wx >= x0 + 32 || wz < z0 || wz >= z0 + 32 {
                            continue;
                        }
                        for wy in y0..y0 + 32 {
                            let solid = if unseen {
                                // the unexplored is a wall
                                true
                            } else {
                                match &chunk {
                                    Some(c) => c.block(lx as usize, wy, lz as usize).map(|b| {
                                        let st = assets.models.state(b);
                                        st.solid || (st.occludes != 0 && st.fluid.is_none())
                                    }).unwrap_or(wy < dim.min_y()),
                                    None => true,
                                }
                            };
                            if solid {
                                let i = (((wy - y0) * 32 + (wz - z0)) * 32 + (wx - x0)) as usize;
                                bits[i >> 3] |= 1 << (i & 7);
                            }
                        }
                    }
                }
            }
        }
        bits
    })
    .await
    .map_err(err)?;
    Ok(tauri::ipc::Response::new(out))
}

/// Which seen chunks changed since the frontend last asked (live updates while playing).
#[tauri::command]
async fn poll(state: State<'_, AppState>, dim: String) -> R<Value> {
    let ctx = state.ctx()?;
    let capsule_open = state.capsule.read().is_some();
    let assets = state.assets.read().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let d = dim_of(&dim);
        let old = ctx.explored(d);
        let mut changed = Vec::new();
        for (rx, rz, p) in ctx.world.regions(d) {
            let m = mcworld::world::mtime_ms(&p);
            if old.region_mtimes.get(&(rx, rz)).map(|o| *o != m).unwrap_or(true) {
                changed.push([rx, rz]);
            }
        }
        if !changed.is_empty() {
            ctx.refresh_explored(d);
        }
        if capsule_open {
            changed.clear();
        }
        json!({ "open": ctx.world.is_open_in_game(), "changed": changed, "summary": summary_of(&ctx, assets.as_deref()) })
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn entities(state: State<'_, AppState>, dim: String, x: f64, z: f64, radius: f64) -> R<Vec<Value>> {
    let ctx = state.view()?;
    let assets = state.assets.read().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let d = dim_of(&dim);
        let e = ctx.explored(d);
        let mut out = Vec::new();
        let (rx0, rz0) = (((x - radius).floor() as i32) >> 9, ((z - radius).floor() as i32) >> 9);
        let (rx1, rz1) = (((x + radius).floor() as i32) >> 9, ((z + radius).floor() as i32) >> 9);
        for rz in rz0..=rz1 {
            for rx in rx0..=rx1 {
                for en in ctx.world.entities_in_region(d, rx, rz) {
                    let pos = en.get_list("Pos");
                    if pos.len() != 3 {
                        continue;
                    }
                    let p = [pos[0].f64().unwrap_or(0.0), pos[1].f64().unwrap_or(0.0), pos[2].f64().unwrap_or(0.0)];
                    if (p[0] - x).hypot(p[2] - z) > radius {
                        continue;
                    }
                    if !e.seen.contains(&((p[0].floor() as i32) >> 4, (p[2].floor() as i32) >> 4)) {
                        continue;
                    }
                    let id = en.get_str("id").unwrap_or("").to_string();
                    let rot = en.get_list("Rotation");
                    let name = en.get("CustomName").map(mcworld::nbt::text_of).filter(|s| !s.is_empty());
                    let display = assets.as_ref().map(|a| a.lang.entity_name(&id)).unwrap_or_default();
                    let item = en.get("Item").and_then(mcworld::items::item_of).map(|i| i.id);
                    let villager = en.get("VillagerData").map(|v| json!({ "profession": v.get_str("profession"), "type": v.get_str("type"), "level": v.get_i64("level") }));
                    out.push(json!({
                        "id": id,
                        "name": name,
                        "display": display,
                        "pos": p,
                        "yaw": rot.first().and_then(|v| v.f64()).unwrap_or(0.0),
                        "health": en.get_f64("Health"),
                        "baby": en.get_i64("Age").map(|a| a < 0).unwrap_or(false) || en.get_i64("IsBaby").map(|b| b != 0).unwrap_or(false),
                        "variant": en.get_str("variant").or_else(|| en.get_str("Variant")).map(|s| s.to_string()).or_else(|| en.get_i64("Variant").map(|v| v.to_string())),
                        "color": en.get_i64("Color"),
                        "item": item,
                        "villager": villager,
                        "tamed": en.get("Owner").is_some(),
                        "sheared": en.get_i64("Sheared").map(|b| b != 0).unwrap_or(false),
                    }));
                }
            }
        }
        out
    })
    .await
    .map_err(err)
}

// ---------------------------------------------------------------- dex

#[tauri::command]
async fn dex(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = ctx.sessions(&assets);
        dex::compute(&ctx, &assets, &sessions)
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn dex_reveal(state: State<'_, AppState>, keys: Vec<String>) -> R<()> {
    let ctx = state.ctx()?;
    dex::reveal(&ctx.dir, &keys);
    Ok(())
}

// ---------------------------------------------------------------- the in-game companion

/// A card the in-game Atlas Companion asked to show (its "open Atlas" key): `--open-card <key> [--world <path>]`.
static OPEN_CARD: Mutex<Option<Value>> = Mutex::new(None);

fn open_card_arg(args: &[String]) -> Option<Value> {
    let i = args.iter().position(|a| a == "--open-card")?;
    let key = args.get(i + 1)?.clone();
    let world = args.iter().position(|a| a == "--world").and_then(|j| args.get(j + 1)).cloned();
    Some(json!({ "key": key, "world": world }))
}

#[tauri::command]
fn take_open_card() -> Option<Value> {
    OPEN_CARD.lock().take()
}

/// When the companion last wrote anything for this world (so the Dex can refresh on alt-tab).
#[tauri::command]
fn companion_stamp(state: State<'_, AppState>) -> R<i64> {
    let ctx = state.ctx()?;
    Ok(atlascore::companion::stamp(&ctx.dir))
}

#[tauri::command]
async fn search_items(state: State<'_, AppState>, query: String) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(idx) = ctx.index.read().clone() else { return json!({ "ready": false }) };
        let names = |id: &str| assets.lang.name(id);
        let hits = search::search(&idx, &query, &names, 400);
        let mut names_map: HashMap<String, String> = HashMap::new();
        for h in &hits {
            for m in &h.matches {
                names_map.entry(m.0.clone()).or_insert_with(|| assets.lang.name(&m.0));
            }
            names_map.entry(h.kind.clone()).or_insert_with(|| if h.kind.starts_with("player:") { String::new() } else { assets.lang.name(&h.kind) });
        }
        json!({ "ready": true, "hits": hits, "names": names_map, "containers": idx.containers.len() })
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn storage_totals(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(idx) = ctx.index.read().clone() else { return json!({ "ready": false }) };
        let t = search::totals(&idx);
        let items: Vec<Value> = t.iter().map(|(id, n, c)| json!({ "id": id, "name": assets.lang.name(id), "count": n, "containers": c })).collect();
        let mut kinds: HashMap<String, usize> = HashMap::new();
        for c in &idx.containers {
            *kinds.entry(c.kind.clone()).or_default() += 1;
        }
        json!({ "ready": true, "items": items, "containers": idx.containers.len(), "kinds": kinds, "built": idx.built_ms })
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn container(state: State<'_, AppState>, id: usize) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    let idx = ctx.index.read().clone().ok_or("index not ready")?;
    let c = idx.containers.get(id).ok_or("no such container")?;
    let mut names = HashMap::new();
    fn walk(items: &[mcworld::items::Item], a: &Assets, names: &mut HashMap<String, String>) {
        for i in items {
            names.entry(i.id.clone()).or_insert_with(|| a.lang.name(&i.id));
            walk(&i.contents, a, names);
        }
    }
    walk(&c.items, &assets, &mut names);
    Ok(json!({ "container": c, "names": names, "kind_name": assets.lang.name(&c.kind) }))
}

#[tauri::command]
async fn rebuild_index(state: State<'_, AppState>) -> R<()> {
    let ctx = state.ctx()?;
    let assets = state.assets.read().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ctx.rebuild_index();
        tools::on_index_built(&ctx, assets.as_ref());
    })
    .await
    .map_err(err)
}

// ---------------------------------------------------------------- stats / timeline

#[tauri::command]
async fn player_stats(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let uuid = ctx.player_uuid.clone().unwrap_or_default();
        let st = ctx.world.stats_json(&uuid).unwrap_or(Value::Null);
        let adv = ctx.world.advancements_json(&uuid).unwrap_or(Value::Null);
        let summary = stats::summary(&st);
        let advs = stats::advancements(&adv, &assets.lang);
        let sessions = ctx.sessions(&assets);
        let cal = stats::calendar(&sessions);
        let mut names: HashMap<String, String> = HashMap::new();
        for key in ["top_mined", "top_crafted", "top_used", "top_killed", "top_killed_by", "top_picked_up", "top_broken"] {
            if let Some(a) = summary.get(key).and_then(|v| v.as_array()) {
                for e in a {
                    if let Some(id) = e.get(0).and_then(|v| v.as_str()) {
                        let entity = key == "top_killed" || key == "top_killed_by";
                        names.entry(id.to_string()).or_insert_with(|| if entity { assets.lang.entity_name(id) } else { assets.lang.name(id) });
                    }
                }
            }
        }
        let total_adv = assets.lang.map.keys().filter(|k| k.starts_with("advancements.") && k.ends_with(".title") && !k.contains(".root.")).count();
        json!({
            "summary": summary,
            "advancements": advs,
            "advancements_total": total_adv,
            "sessions": sessions.iter().map(|s| json!({ "start": s.start, "end": s.end, "login": s.login_pos })).collect::<Vec<_>>(),
            "calendar": cal,
            "names": names,
        })
    })
    .await
    .map_err(err)
}

fn all_events(ctx: &Ctx, assets: &Assets) -> Vec<Event> {
    let level = ctx.world.level().ok();
    let day_time = level.as_ref().map(|l| l.day_time).unwrap_or(0);
    let sessions = ctx.sessions(assets);
    let clock = stats::DayClock::new(&sessions, day_time);
    let mut evs = stats::session_events(&sessions, &clock);
    // advancements with exact dates from the advancements file (more complete than the logs)
    if let Some(uuid) = &ctx.player_uuid {
        if let Some(adv) = ctx.world.advancements_json(uuid) {
            for a in stats::advancements(&adv, &assets.lang) {
                if a.done_ms <= 0 {
                    continue;
                }
                if evs.iter().any(|e| e.kind == "advancement" && e.title == a.title) {
                    continue;
                }
                evs.push(Event { t: a.done_ms, day: Some(clock.day_at(a.done_ms)), kind: "advancement".into(), title: a.title.clone(), detail: a.frame.clone(), pos: None, dim: None, source: "advancements".into() });
            }
        }
    }
    // journal (recorder + earlier backfills)
    for mut e in atlascore::events::load(&ctx.dir) {
        if evs.iter().any(|x| x.kind == e.kind && x.title == e.title && (x.t - e.t).abs() < 120_000) {
            continue;
        }
        if e.day.is_none() {
            e.day = Some(clock.day_at(e.t));
        }
        evs.push(e);
    }
    evs.sort_by_key(|e| e.t);
    evs
}

#[tauri::command]
async fn timeline(state: State<'_, AppState>) -> R<Value> {
    let ctx = state.ctx()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let evs = all_events(&ctx, &assets);
        json!({ "events": evs })
    })
    .await
    .map_err(err)
}

// ---------------------------------------------------------------- places

fn current_places(ctx: &Ctx) -> Vec<Place> {
    let existing = atlascore::lore::load_places(&ctx.dir);
    let mut all = Vec::new();
    for d in Dim::all() {
        let e = ctx.explored(d);
        let mut found = places::detect(&e, d.id(), &existing);
        // fill in surface heights of the place centers
        for p in found.iter_mut() {
            if p.dim == d.id() && p.center[1] == 64 {
                if let Some(c) = ctx.world.chunk(d, p.center[0] >> 4, p.center[2] >> 4) {
                    if let Some(s) = &c.motion {
                        p.center[1] = s[((p.center[2] & 15) * 16 + (p.center[0] & 15)) as usize] + 1;
                    }
                }
            }
        }
        for p in found {
            if !all.iter().any(|x: &Place| x.id == p.id) {
                all.push(p);
            }
        }
    }
    let _ = atlascore::lore::save_places(&ctx.dir, &all);
    all
}

#[tauri::command]
async fn places_list(state: State<'_, AppState>) -> R<Vec<Place>> {
    let ctx = state.ctx()?;
    tauri::async_runtime::spawn_blocking(move || current_places(&ctx)).await.map_err(err)
}

#[tauri::command]
async fn place_update(state: State<'_, AppState>, id: String, name: Option<String>, hidden: Option<bool>, notes: Option<String>, accept: Option<bool>, reject: Option<bool>) -> R<Vec<Place>> {
    let ctx = state.ctx()?;
    let mut ps = atlascore::lore::load_places(&ctx.dir);
    if let Some(p) = ps.iter_mut().find(|p| p.id == id) {
        if let Some(n) = name {
            p.name = n.trim().to_string();
        }
        if let Some(h) = hidden {
            p.hidden = h;
        }
        if let Some(n) = notes {
            p.notes = n;
        }
        if accept == Some(true) {
            if let Some(s) = p.suggested.clone() {
                p.name = s;
            }
        }
        if reject == Some(true) {
            p.suggested = None;
        }
    }
    atlascore::lore::save_places(&ctx.dir, &ps).map_err(err)?;
    Ok(ps)
}

// ---------------------------------------------------------------- lore book

#[tauri::command]
async fn save_plate(state: State<'_, AppState>, key: String, data_url: String) -> R<String> {
    let ctx = state.ctx()?;
    let b64 = data_url.split_once(',').map(|p| p.1).unwrap_or(&data_url);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(err)?;
    let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let dir = atlascore::lore::lore_dir(&ctx.dir).join("plates");
    let ext = if data_url.starts_with("data:image/jpeg") { "jpg" } else { "png" };
    let p = dir.join(format!("{safe}.{ext}"));
    std::fs::write(&p, bytes).map_err(err)?;
    Ok(format!("plate/{}/{safe}.{ext}", atlascore::world_id(&ctx.entry.path)))
}

#[tauri::command]
async fn save_photo(data_url: String) -> R<String> {
    let b64 = data_url.split_once(',').map(|p| p.1).unwrap_or(&data_url);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(err)?;
    let pics = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default().join("Pictures").join("Longevity");
    std::fs::create_dir_all(&pics).map_err(err)?;
    let name = format!("longevity-{}.png", atlascore::now_ms());
    let p = pics.join(name);
    std::fs::write(&p, bytes).map_err(err)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_path(path: String) -> R<()> {
    std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------- recorder

// ---------------------------------------------------------------- custom protocol

fn respond(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap()
}

fn seen_hash(e: &Explored, rx: i32, rz: i32) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for lz in 0..32 {
        for lx in 0..32 {
            if e.seen.contains(&(rx * 32 + lx, rz * 32 + lz)) {
                h ^= (lz * 32 + lx) as u64 + 1;
                h = h.wrapping_mul(1099511628211);
            }
        }
    }
    h
}

fn handle_protocol(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["packimg", inst, file, rest @ ..] => {
            let rel = rest.join("/");
            match packview::proto_pack(&launcher::pct_decode(inst), &launcher::pct_decode(file), &launcher::pct_decode(&rel)) {
                Some(b) => respond(200, "image/png", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["vanillaimg", rest @ ..] => {
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            match packview::proto_vanilla(&assets, &launcher::pct_decode(&rest.join("/"))) {
                Some(b) => respond(200, "image/png", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["iconx", size, id] => {
            let id = id.trim_end_matches(".png").replace("%3A", ":");
            let size: u32 = size.parse::<u32>().unwrap_or(128).clamp(16, 256);
            let key = format!("{size}|{id}");
            if let Some(b) = state.icons.lock().get(&key) {
                return respond(200, "image/png", b.clone());
            }
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let png = mcassets::icons::item_icon(&assets, &id, size).map(|i| tiles::png_bytes(&i)).unwrap_or_default();
            state.icons.lock().insert(key, png.clone());
            if png.is_empty() { respond(404, "text/plain", vec![]) } else { respond(200, "image/png", png) }
        }
        ["disc", song] => {
            let song = song.trim_end_matches(".ogg");
            if song.is_empty() || !song.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return respond(400, "text/plain", vec![]);
            }
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let ev = assets
                .jar
                .json(&format!("data/minecraft/jukebox_song/{song}.json"))
                .and_then(|j| {
                    let s = j.get("sound_event")?;
                    s.as_str().or_else(|| s.get("sound_id").and_then(|x| x.as_str())).map(|x| x.to_string())
                })
                .unwrap_or_else(|| format!("minecraft:music_disc.{song}"));
            match sounds::disc(&ev) {
                Some(b) => respond(200, "audio/ogg", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["icon", id] => {
            let id = id.trim_end_matches(".png").replace("%3A", ":");
            if let Some(b) = state.icons.lock().get(&id) {
                return respond(200, "image/png", b.clone());
            }
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let png = mcassets::icons::item_icon(&assets, &id, 64).map(|i| tiles::png_bytes(&i)).unwrap_or_default();
            state.icons.lock().insert(id, png.clone());
            if png.is_empty() { respond(404, "text/plain", vec![]) } else { respond(200, "image/png", png) }
        }
        ["tile", dim, style, rx, rz] | ["lod", dim, style, rx, rz] => {
            let is_lod = parts[0] == "lod";
            let (Ok(rx), Ok(rz)) = (rx.parse::<i32>(), rz.trim_end_matches(".png").parse::<i32>()) else { return respond(400, "text/plain", vec![]) };
            let Ok(ctx) = state.view() else { return respond(404, "text/plain", vec![]) };
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let d = dim_of(&dim.replace("%3A", ":"));
            let e = ctx.explored(d);
            let rp = ctx.world.dim_dir(d).join("region").join(format!("r.{rx}.{rz}.mca"));
            let mtime = mcworld::world::mtime_ms(&rp);
            let sh = seen_hash(&e, rx, rz);
            let dir = ctx.dir.join("tiles").join(d.id().replace(':', "_"));
            let _ = std::fs::create_dir_all(&dir);
            let style = if is_lod { "lod" } else { style };
            let file = dir.join(format!("{style}.{rx}.{rz}.{mtime}.{sh:x}.{}", if is_lod { "bin" } else { "png" }));
            if let Ok(b) = std::fs::read(&file) {
                return respond(200, if is_lod { "application/octet-stream" } else { "image/png" }, b);
            }
            if !rp.is_file() {
                return respond(404, "text/plain", vec![]);
            }
            let data = tiles::region_data(&ctx.world, &assets, d, rx, rz, &e.seen);
            let bytes = if is_lod {
                tiles::lod_bytes(&data)
            } else if style == "parchment" {
                tiles::png_bytes(&tiles::render_parchment(&data, rx, rz))
            } else {
                tiles::png_bytes(&tiles::render_color(&data))
            };
            // drop older versions of this tile
            if let Ok(rd) = std::fs::read_dir(&dir) {
                let prefix = format!("{style}.{rx}.{rz}.");
                for f in rd.flatten() {
                    if f.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_file(f.path());
                    }
                }
            }
            let _ = std::fs::write(&file, &bytes);
            respond(200, if is_lod { "application/octet-stream" } else { "image/png" }, bytes)
        }
        ["plate", _world, file] => {
            let Ok(ctx) = state.ctx() else { return respond(404, "text/plain", vec![]) };
            let p = atlascore::lore::lore_dir(&ctx.dir).join("plates").join(file);
            match std::fs::read(&p) {
                Ok(b) => respond(200, if file.ends_with(".jpg") { "image/jpeg" } else { "image/png" }, b),
                Err(_) => respond(404, "text/plain", vec![]),
            }
        }
        ["block", id] => {
            // raw block texture (for UI decoration)
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            match assets.jar.get(&format!("textures/{}.png", id.replace("%2F", "/").trim_end_matches(".png"))) {
                Some(b) => respond(200, "image/png", b.to_vec()),
                None => respond(404, "text/plain", vec![]),
            }
        }
        _ => respond(404, "text/plain", vec![]),
    }
}

/// `--dex-dump <world path> <out.json>`: compute the Dex (and a capsule if due) without a window (testing).
fn headless_dex(args: &[String]) -> i32 {
    let (Some(path), Some(out)) = (args.get(2), args.get(3)) else { return 2 };
    let Ok(assets) = Assets::discover("26.3") else { return 3 };
    let Some(entry) = mcworld::world::discover().into_iter().find(|w| w.path.to_string_lossy() == path.as_str()) else { return 4 };
    let Ok(world) = World::open(&entry.path) else { return 5 };
    let dir = atlascore::world_dir(&entry.path);
    let uuid = world.players().first().map(|(u, _)| u.clone());
    let name = player_name(&entry.path, uuid.as_deref());
    let ctx = Ctx { entry, world, dir, explored: RwLock::new(HashMap::new()), index: RwLock::new(None), player_name: name, player_uuid: uuid, sessions: RwLock::new(None) };
    let t0 = std::time::Instant::now();
    let sessions = ctx.sessions(&assets);
    let v = dex::compute(&ctx, &assets, &sessions);
    let t1 = t0.elapsed().as_millis();
    let _ = std::fs::write(out, serde_json::to_vec_pretty(&json!({ "ms": t1, "dex": v })).unwrap_or_default());
    0
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a == "--dex-dump").unwrap_or(false) {
        std::process::exit(headless_dex(&args));
    }
    if let Some(v) = open_card_arg(&args) {
        *OPEN_CARD.lock() = Some(v);
    }
    let testing = app::testing();
    let mut builder = tauri::Builder::default();
    if !testing {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            app::show(app);
            if let Some(v) = open_card_arg(&args) {
                let _ = app.emit("open-card", v);
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(launcher::LState::default())
        .manage(app::Shell::default())
        .register_asynchronous_uri_scheme_protocol("atlas", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || {
                let r = handle_protocol(&app, &path);
                responder.respond(r);
            });
        })
        .register_asynchronous_uri_scheme_protocol("mio", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || {
                let r = launcher::handle_protocol(&app, &path);
                responder.respond(r);
            });
        })
        .setup(move |app| {
            import::run_once();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let found = Assets::discover("26.3");
                let state = handle.state::<AppState>();
                let lstate = handle.state::<launcher::LState>();
                match found {
                    Ok(a) => {
                        let a = Arc::new(a);
                        *state.assets.write() = Some(a.clone());
                        lstate.set_assets(a);
                    }
                    Err(e) => {
                        let m = format!("Couldn't load Minecraft's textures: {e}");
                        *state.assets_err.write() = Some(m.clone());
                        lstate.set_assets_err(m);
                    }
                }
            });
            app::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update::update_check,
            update::update_install,
            packview::pack_list,
            packview::pack_tex,
            packview::pack_close,
            packview::pack_has,
            app_info,
            settings_set,
            list_worlds,
            open_world,
            world_summary,
            explored,
            textures,
            mesh,
            solid_box,
            walk::w_collide,
            walk::w_ray,
            walk::w_trim,
            walk::w_toggle,
            walk::w_hide,
            walk::w_clear,
            walk::w_lights,
            poll,
            entities,
            search_items,
            storage_totals,
            container,
            rebuild_index,
            player_stats,
            timeline,
            places_list,
            place_update,
            save_photo,
            save_plate,
            open_path,
            dex,
            dex_reveal,
            take_open_card,
            companion_stamp,
            app::close_window,
            tools::t_villagers,
            tools::t_farms,
            tools::t_farm_save,
            tools::t_farm_delete,
            tools::t_doctor,
            tools::t_gear,
            tools::t_projects,
            tools::t_projects_save,
            tools::t_find,
            tools::t_guide,
            tools::t_live,
            tools::t_kills,
            tools::t_glance,
            tools::t_recaps,
            tools::t_recap_seen,
            tools::t_shot_tags,
            tools::t_stats_raw,
            tools::recap::t_recap_latest,
            tools::recap::t_recap_open,
            tools::recap::t_take_recap,
            tools::recap::t_recap_test,
            app::quit_app,
            app::get_autostart,
            app::set_autostart,
            launcher::l_app_info,
            launcher::l_settings_set,
            launcher::instances,
            launcher::worlds,
            launcher::launch,
            launcher::stop_game,
            launcher::l_open_path,
            launcher::open_instance_folder,
            launcher::open_url,
            launcher::open_prism,
            launcher::mods_list,
            launcher::mods_identify,
            launcher::mods_updates,
            launcher::mods_apply_updates,
            launcher::mods_toggle,
            launcher::mods_remove,
            launcher::backups,
            launcher::rollback,
            launcher::store_search,
            launcher::store_project,
            launcher::store_install,
            launcher::crashes,
            launcher::crash_report,
            launcher::raise_memory,
            launcher::skins_list,
            launcher::skins_sync,
            launcher::skins_add_player,
            launcher::skins_import,
            launcher::skins_update,
            launcher::skins_delete,
            launcher::skins_wear,
            launcher::shot_copy_data,
            launcher::finder_start,
            launcher::finder_status,
            launcher::finder_cancel,
            launcher::finder_dismiss,
            launcher::finder_disable,
            launcher::sync_state,
            launcher::sync_set,
            launcher::sync_compare,
            launcher::sync_apply,
            launcher::sync_backups,
            launcher::sync_restore,
            launcher::shot_save_edit,
            launcher::skins_history,
            launcher::skins_refresh,
            launcher::skins_save,
            launcher::shots_list,
            launcher::shot_copy,
            launcher::shot_delete,
            launcher::shot_reveal,
            launcher::history,
            launcher::cmds2::store2_search,
            launcher::cmds2::store2_project,
            launcher::cmds2::store2_install,
            launcher::cmds2::saved_list,
            launcher::cmds2::saved_toggle,
            launcher::cmds2::packs_list,
            launcher::cmds2::pack_toggle,
            launcher::cmds2::pack_use_shader,
            launcher::cmds2::pack_delete,
            launcher::cmds2::inst_versions,
            launcher::cmds2::inst_loaders,
            launcher::cmds2::inst_starter,
            launcher::cmds2::inst_items,
            launcher::cmds2::inst_create,
            launcher::cmds2::modpack_preview,
            launcher::cmds2::modpack_install,
            launcher::cmds2::pack_file_kind,
            launcher::cmds2::prism_import,
            launcher::cmds2::inst_export,
            launcher::cmds2::inst_duplicate,
            launcher::cmds2::inst_rename,
            launcher::cmds2::inst_delete,
            launcher::cmds2::inst_set_icon,
            launcher::cmds2::inst_settings,
            launcher::cmds2::inst_set_memory,
            launcher::cmds2::inst_set_java,
            launcher::cmds2::inst_upgrade_targets,
            launcher::cmds2::inst_upgrade_check,
            launcher::cmds2::inst_upgrade
        ])
        .build(tauri::generate_context!())
        .expect("error while building Longevity");
    app.run(app::on_run_event);
}
