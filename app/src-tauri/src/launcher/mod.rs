//! The Mio Launcher backend, now part of Longevity: instances, mods, store, skins, screenshots, history.

pub mod cmds2;
pub mod crash;
pub mod finder;
pub mod history;
pub mod instances;
pub mod mods;
pub mod perf;
pub mod prism;
pub mod shots;
pub mod skins;
pub mod store;
pub mod sync;
pub mod util;

use base64::Engine as _;
use mcassets::Assets;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use util::*;

#[derive(Default)]
pub struct LState {
    assets: RwLock<Option<Arc<Assets>>>,
    assets_err: RwLock<Option<String>>,
    icons: Mutex<HashMap<String, Vec<u8>>>,
    modicons: Mutex<HashMap<String, Vec<u8>>>,
    pub launched: Mutex<HashMap<String, i64>>,
    busy: std::sync::atomic::AtomicBool,
}

struct Busy<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl LState {
    pub fn set_assets(&self, a: Arc<Assets>) {
        *self.assets.write() = Some(a);
    }
    pub fn set_assets_err(&self, e: String) {
        *self.assets_err.write() = Some(e);
    }
    pub fn busy(&self) -> R<Busy<'_>> {
        if self.busy.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err("Already working on your mods".into());
        }
        Ok(Busy(&self.busy))
    }
    pub fn assets(&self) -> R<Arc<Assets>> {
        for _ in 0..600 {
            if let Some(a) = self.assets.read().clone() {
                return Ok(a);
            }
            if let Some(e) = self.assets_err.read().clone() {
                return Err(e);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("Minecraft's textures are still loading".into())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub sounds: bool,
    pub instance: Option<String>,
    pub hide_on_play: bool,
    pub backdrop: bool,
    pub quality: String,
    pub favorites: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { sounds: true, instance: None, hide_on_play: true, backdrop: true, quality: "high".into(), favorites: vec![] }
    }
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

fn load_settings() -> Settings {
    read_json(&settings_path())
}

fn inst(id: &str) -> R<prism::Instance> {
    prism::instance(id).ok_or_else(|| "That instance doesn't exist anymore".to_string())
}

fn mc_of(i: &prism::Instance) -> PathBuf {
    PathBuf::from(&i.mc_dir)
}

fn not_running(id: &str) -> R<()> {
    if prism::running().contains_key(id) {
        return Err("Close Minecraft first. The game is using these files right now.".into());
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

// ------------------------------------------------------------------ app

#[tauri::command]
pub fn l_app_info(state: State<'_, LState>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "prism": prism::exe().map(|p| p.to_string_lossy().to_string()),
        "prism_data": prism::data_dir().to_string_lossy(),
        "assets_ready": state.assets.read().is_some(),
        "assets_error": state.assets_err.read().clone(),
        "settings": load_settings(),
        "test_tour": std::env::var("MIO_TEST_TOUR").ok(),
        "test_interval": std::env::var("MIO_TEST_INTERVAL").ok().and_then(|v| v.parse::<u32>().ok()),
        "ram_mb": perf::total_ram_mb(),
    })
}

#[tauri::command]
pub fn l_settings_set(settings: Settings) -> R<()> {
    write_json(&settings_path(), &settings).map_err(err)
}

#[tauri::command]
pub async fn instances() -> R<Value> {
    blocking(|| {
        let list = prism::instances();
        let running: HashMap<String, u64> = prism::running().into_iter().map(|(k, v)| (k, v.1)).collect();
        Ok(json!({ "instances": list, "running": running }))
    })
    .await
}

#[derive(Serialize)]
pub struct WorldItem {
    folder: String,
    name: String,
    last_played: i64,
    icon: bool,
    hardcore: bool,
    day: i64,
    mode: i64,
}

#[tauri::command]
pub async fn worlds(id: String) -> R<Vec<WorldItem>> {
    blocking(move || {
        let i = inst(&id)?;
        let saves = mc_of(&i).join("saves");
        let mut out: Vec<WorldItem> = std::fs::read_dir(&saves)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().join("level.dat").is_file())
                    .map(|e| {
                        let info = mcworld::world::read_level(&e.path()).ok();
                        WorldItem {
                            folder: e.file_name().to_string_lossy().to_string(),
                            name: info.as_ref().map(|l| l.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| e.file_name().to_string_lossy().to_string()),
                            last_played: info.as_ref().map(|l| l.last_played).unwrap_or(0),
                            icon: e.path().join("icon.png").is_file(),
                            hardcore: info.as_ref().map(|l| l.hardcore).unwrap_or(false),
                            day: info.as_ref().map(|l| l.day()).unwrap_or(0),
                            mode: info.as_ref().map(|l| l.game_type).unwrap_or(0),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b.last_played.cmp(&a.last_played));
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn launch(app: tauri::AppHandle, state: State<'_, LState>, id: String, server: Option<String>, world: Option<String>) -> R<Value> {
    let i = inst(&id)?;
    if prism::running().contains_key(&id) {
        return Err("That instance is already running".into());
    }
    state.launched.lock().insert(id.clone(), now_ms());
    blocking(move || prism::launch(&i.id, server.as_deref(), world.as_deref()).map_err(err)).await?;
    let _ = app.emit("launching", json!({ "id": id }));
    Ok(json!({}))
}

#[tauri::command]
pub async fn stop_game(id: String) -> R<()> {
    blocking(move || {
        if let Some((pid, _)) = prism::running().get(&id) {
            prism::kill(*pid);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn l_open_path(path: String) -> R<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("That folder doesn't exist".into());
    }
    let mut c = std::process::Command::new("explorer");
    if p.is_file() {
        c.arg(format!("/select,{}", p.to_string_lossy()));
    } else {
        c.arg(p);
    }
    c.spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn open_instance_folder(id: String, sub: Option<String>) -> R<()> {
    let i = inst(&id)?;
    let mut p = mc_of(&i);
    if let Some(s) = sub.filter(|s| ["mods", "saves", "screenshots", "shaderpacks", "resourcepacks", "logs", "crash-reports", "config"].contains(&s.as_str())) {
        p = p.join(s);
        let _ = std::fs::create_dir_all(&p);
    }
    l_open_path(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> R<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("bad link".into());
    }
    let mut c = std::process::Command::new("rundll32");
    c.args(["url.dll,FileProtocolHandler", &url]);
    c.spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn open_prism() -> R<()> {
    prism::open_prism().map_err(err)
}

// ------------------------------------------------------------------ mods

#[tauri::command]
pub async fn mods_list(id: String) -> R<Vec<mods::InstalledMod>> {
    blocking(move || Ok(mods::installed(&mc_of(&inst(&id)?)))).await
}

#[tauri::command]
pub async fn mods_identify(id: String) -> R<Vec<mods::InstalledMod>> {
    blocking(move || {
        let mc = mc_of(&inst(&id)?);
        mods::identify(&mc, false).map_err(err)?;
        Ok(mods::installed(&mc))
    })
    .await
}

#[tauri::command]
pub async fn mods_updates(id: String) -> R<Vec<mods::UpdateInfo>> {
    blocking(move || {
        let i = inst(&id)?;
        mods::check_updates(&mc_of(&i), &i.loader, &i.mc_version).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn mods_apply_updates(state: State<'_, LState>, id: String, picks: Vec<(String, String)>) -> R<Vec<String>> {
    let _g = state.busy()?;
    not_running(&id)?;
    blocking(move || {
        let i = inst(&id)?;
        mods::apply_updates(&i.id, &mc_of(&i), &picks).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn mods_toggle(id: String, file: String, enabled: bool) -> R<String> {
    not_running(&id)?;
    blocking(move || mods::set_enabled(&mc_of(&inst(&id)?), &file, enabled).map_err(err)).await
}

#[tauri::command]
pub async fn mods_remove(id: String, file: String) -> R<()> {
    not_running(&id)?;
    blocking(move || {
        let i = inst(&id)?;
        mods::remove(&i.id, &mc_of(&i), &file).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn backups(id: String) -> R<Vec<mods::Backup>> {
    blocking(move || Ok(mods::list_backups(&id))).await
}

#[tauri::command]
pub async fn rollback(id: String, backup: Option<String>) -> R<String> {
    not_running(&id)?;
    blocking(move || {
        let i = inst(&id)?;
        let b = match backup {
            Some(b) => b,
            None => mods::list_backups(&id).into_iter().find(|b| !b.reason.starts_with("Before rolling back")).map(|b| b.id).ok_or("There's no backup to roll back to yet")?,
        };
        mods::rollback(&i.id, &mc_of(&i), &b).map_err(err)?;
        Ok(b)
    })
    .await
}

#[tauri::command]
pub async fn store_search(id: String, query: String, offset: u32, sort: String, category: Option<String>) -> R<Value> {
    blocking(move || {
        let i = inst(&id)?;
        mods::search(&query, offset, &sort, category.as_deref(), &i.loader, &i.mc_version).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn store_project(id: String, project: String) -> R<Value> {
    blocking(move || {
        let i = inst(&id)?;
        mods::project(&project, &i.loader, &i.mc_version).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn store_install(state: State<'_, LState>, id: String, project: String) -> R<Vec<String>> {
    let _g = state.busy()?;
    not_running(&id)?;
    blocking(move || {
        let i = inst(&id)?;
        mods::install(&i.id, &mc_of(&i), &project, &i.loader, &i.mc_version).map_err(err)
    })
    .await
}

// ------------------------------------------------------------------ crashes

#[tauri::command]
pub async fn crashes(id: String) -> R<Vec<crash::CrashItem>> {
    blocking(move || {
        let mc = mc_of(&inst(&id)?);
        Ok(crash::history(&mc, &mods::installed(&mc)))
    })
    .await
}

#[tauri::command]
pub async fn crash_report(id: String, crash: String) -> R<crash::Report> {
    blocking(move || {
        let mc = mc_of(&inst(&id)?);
        crash::report(&mc, &crash, &mods::installed(&mc)).ok_or_else(|| "That crash report is gone".to_string())
    })
    .await
}

#[tauri::command]
pub async fn raise_memory(id: String) -> R<i64> {
    blocking(move || perf::raise_memory(&inst(&id)?).map_err(err)).await
}

// ------------------------------------------------------------------ performance

// ------------------------------------------------------------------ skins

#[tauri::command]
pub async fn skins_list() -> R<Value> {
    blocking(|| Ok(json!({ "skins": skins::list(), "profiles": prism::profiles() }))).await
}

#[tauri::command]
pub async fn skins_sync() -> R<Vec<skins::Skin>> {
    blocking(|| {
        skins::sync_accounts();
        Ok(skins::list())
    })
    .await
}

#[tauri::command]
pub async fn skins_add_player(name: String) -> R<skins::Skin> {
    blocking(move || skins::add_player(&name).map_err(err)).await
}

#[tauri::command]
pub async fn skins_import(path: String) -> R<skins::Skin> {
    blocking(move || skins::import_file(&path).map_err(err)).await
}

#[tauri::command]
pub async fn skins_update(id: String, name: Option<String>, model: Option<String>, favorite: Option<bool>) -> R<Vec<skins::Skin>> {
    blocking(move || skins::update(&id, name, model, favorite).map_err(err)).await
}

#[tauri::command]
pub async fn skins_delete(id: String) -> R<Vec<skins::Skin>> {
    blocking(move || skins::delete(&id).map_err(err)).await
}

#[tauri::command]
pub async fn skins_history() -> R<Vec<skins::Seen>> {
    blocking(|| Ok(skins::history())).await
}

/// Your accounts' skins and every friend's latest, then the whole closet + history.
#[tauri::command]
pub async fn skins_refresh() -> R<Value> {
    blocking(|| {
        skins::sync_accounts();
        let changed = skins::refresh_friends();
        Ok(json!({ "skins": skins::list(), "history": skins::history(), "changed": changed }))
    })
    .await
}

#[tauri::command]
pub async fn skins_save(name: String, model: String, png_b64: String) -> R<skins::Skin> {
    blocking(move || {
        use base64::Engine as _;
        let raw = png_b64.split(',').next_back().unwrap_or("");
        let png = base64::engine::general_purpose::STANDARD.decode(raw).map_err(err)?;
        skins::save_png(&name, &model, &png).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn skins_wear(id: String) -> R<String> {
    blocking(move || {
        let p = skins::export_for_wear(&id).map_err(err)?;
        let _ = l_open_path(p.to_string_lossy().to_string());
        let _ = open_url("https://www.minecraft.net/en-us/msaprofile/mygames/editskin".into());
        Ok(p.to_string_lossy().to_string())
    })
    .await
}

// ------------------------------------------------------------------ screenshots

#[tauri::command]
pub async fn shots_list() -> R<Vec<shots::Shot>> {
    blocking(|| Ok(shots::list())).await
}

#[tauri::command]
pub async fn shot_copy(key: String) -> R<()> {
    blocking(move || shots::copy_to_clipboard(&key).map_err(err)).await
}

fn b64_bytes(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s.split(',').next_back().unwrap_or("")).map_err(err)
}

#[tauri::command]
pub async fn shot_copy_data(png_b64: String) -> R<()> {
    blocking(move || shots::copy_png(&b64_bytes(&png_b64)?).map_err(err)).await
}

#[tauri::command]
pub async fn shot_save_edit(key: String, png_b64: String) -> R<String> {
    blocking(move || shots::save_edit(&key, &b64_bytes(&png_b64)?).map_err(err)).await
}

// ------------------------------------------------------------------ crash finder

#[tauri::command]
pub fn finder_start(app: tauri::AppHandle, id: String) -> R<()> {
    finder::start(app, id).map_err(err)
}

#[tauri::command]
pub fn finder_status() -> R<finder::Status> {
    Ok(finder::status())
}

#[tauri::command]
pub fn finder_cancel() -> R<()> {
    finder::cancel();
    Ok(())
}

#[tauri::command]
pub fn finder_dismiss() -> R<()> {
    finder::dismiss();
    Ok(())
}

#[tauri::command]
pub async fn finder_disable(id: String, file: String) -> R<()> {
    blocking(move || finder::disable_in(&id, &file).map_err(err)).await
}

// ------------------------------------------------------------------ settings sync

#[tauri::command]
pub async fn sync_state() -> R<sync::SyncState> {
    blocking(|| Ok(sync::state())).await
}

#[tauri::command]
pub async fn sync_set(a: String, b: String, auto: bool, cats: Vec<String>, packs: bool) -> R<()> {
    blocking(move || {
        if !prism::safe_id(&a) || !prism::safe_id(&b) {
            return Err("bad instance".into());
        }
        sync::set_state(a, b, auto, cats, packs);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn sync_compare(a: String, b: String) -> R<Value> {
    blocking(move || sync::compare(&a, &b).map_err(err)).await
}

#[tauri::command]
pub async fn sync_apply(a: String, b: String, plan: Value) -> R<Value> {
    blocking(move || {
        let plan: sync::Plan = serde_json::from_value(plan).map_err(err)?;
        sync::apply(&a, &b, &plan).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn sync_backups() -> R<Vec<Value>> {
    blocking(|| Ok(sync::backups())).await
}

#[tauri::command]
pub async fn sync_restore(id: String) -> R<usize> {
    blocking(move || sync::restore(&id).map_err(err)).await
}

#[tauri::command]
pub async fn shot_delete(key: String) -> R<()> {
    blocking(move || shots::delete(&key).map_err(err)).await
}

#[tauri::command]
pub fn shot_reveal(key: String) -> R<()> {
    let p = shots::resolve(&key).ok_or("screenshot not found")?;
    l_open_path(p.to_string_lossy().to_string())
}

// ------------------------------------------------------------------ history

#[tauri::command]
pub async fn history() -> R<Value> {
    blocking(|| {
        let insts = prism::instances();
        Ok(json!({
            "sessions": history::sessions(),
            "worlds": history::world_times(),
            "instances": insts.iter().map(|i| json!({ "id": i.id, "name": i.name, "icon": i.icon, "total": i.total_played, "last": i.last_session, "last_launch": i.last_launch })).collect::<Vec<_>>(),
            "today": history::today(),
        }))
    })
    .await
}

fn respond(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "max-age=60")
        .body(body)
        .unwrap()
}

pub(crate) fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn b64key(s: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches(".png").trim_end_matches(".jpg")).ok()?;
    String::from_utf8(raw).ok()
}

fn mime_of(p: &std::path::Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    }
}

pub fn handle_protocol(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let state = app.state::<LState>();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["icon", id] => {
            let id = pct_decode(id.trim_end_matches(".png"));
            if let Some(b) = state.icons.lock().get(&id) {
                return respond(200, "image/png", b.clone());
            }
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let png = mcassets::icons::item_icon(&assets, &id, 64).map(|i| crate::tiles::png_bytes(&i)).unwrap_or_default();
            state.icons.lock().insert(id, png.clone());
            if png.is_empty() { respond(404, "text/plain", vec![]) } else { respond(200, "image/png", png) }
        }
        ["block", id] => {
            let Ok(assets) = state.assets() else { return respond(503, "text/plain", vec![]) };
            let id = pct_decode(id);
            match assets.jar.get(&format!("textures/{}.png", id.trim_end_matches(".png"))) {
                Some(b) => respond(200, "image/png", b.to_vec()),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["insticon", key] => {
            let key = pct_decode(key);
            match prism::icon_file(&key).and_then(|p| std::fs::read(&p).ok().map(|b| (b, p))) {
                Some((b, p)) => respond(200, mime_of(&p), b),
                // Prism's built-in icons aren't files; show a grass block from the game instead
                None => match state.assets().ok().and_then(|a| mcassets::icons::item_icon(&a, "grass_block", 128)) {
                    Some(img) => respond(200, "image/png", crate::tiles::png_bytes(&img)),
                    None => respond(404, "text/plain", vec![]),
                },
            }
        }
        ["worldicon", id, folder] => {
            let (id, folder) = (pct_decode(id), pct_decode(folder));
            if !prism::safe_id(&id) || !prism::safe_id(&folder) {
                return respond(400, "text/plain", vec![]);
            }
            let p = prism::mc_dir_of(&prism::instances_dir().join(&id)).join("saves").join(&folder).join("icon.png");
            match std::fs::read(&p) {
                Ok(b) => respond(200, "image/png", b),
                Err(_) => respond(404, "text/plain", vec![]),
            }
        }
        ["modicon", id, file] => {
            let (id, file) = (pct_decode(id), pct_decode(file));
            let key = format!("{id}/{file}");
            if let Some(b) = state.modicons.lock().get(&key) {
                return if b.is_empty() { respond(404, "text/plain", vec![]) } else { respond(200, "image/png", b.clone()) };
            }
            if !prism::safe_id(&id) || !prism::safe_id(&file) {
                return respond(400, "text/plain", vec![]);
            }
            let jar = prism::mc_dir_of(&prism::instances_dir().join(&id)).join("mods").join(&file);
            let meta = mods::read_jar_meta(&jar);
            let bytes = meta.icon.and_then(|i| mods::jar_file(&jar, &i)).unwrap_or_default();
            state.modicons.lock().insert(key, bytes.clone());
            if bytes.is_empty() { respond(404, "text/plain", vec![]) } else { respond(200, "image/png", bytes) }
        }
        ["packicon", id, kind, file] => {
            let (id, kind, file) = (pct_decode(id), pct_decode(kind), pct_decode(file));
            if !prism::safe_id(&id) {
                return respond(400, "text/plain", vec![]);
            }
            let mc = prism::mc_dir_of(&prism::instances_dir().join(&id));
            match store::pack_icon(&mc, &kind, &file) {
                Some(b) => respond(200, "image/png", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["thumb", w, key] => {
            let Some(key) = b64key(key) else { return respond(400, "text/plain", vec![]) };
            let w: u32 = w.parse::<u32>().unwrap_or(480).clamp(120, 1280);
            match shots::thumb(&key, w) {
                Some(b) => respond(200, "image/jpeg", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["shot", key] => {
            let Some(key) = b64key(key) else { return respond(400, "text/plain", vec![]) };
            match shots::resolve(&key).and_then(|p| std::fs::read(&p).ok().map(|b| (b, p))) {
                Some((b, p)) => respond(200, mime_of(&p), b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        ["skin", id] | ["cape", id] => {
            let id = id.trim_end_matches(".png");
            let f = if parts[0] == "skin" { skins::file(id) } else { skins::cape_file(id) };
            match f.and_then(|p| std::fs::read(p).ok()) {
                Some(b) => respond(200, "image/png", b),
                None => respond(404, "text/plain", vec![]),
            }
        }
        _ => respond(404, "text/plain", vec![]),
    }
}

