//! Commands for the full store (every kind of project) and for making and managing instances.

use super::*;

/// A progress reporter for one job: sends "job" events (at most ~12 a second) that the window
/// turns into progress rings.
fn reporter(app: &tauri::AppHandle, job: &str, inst: &str) -> impl Fn(f32, &str) + Send + Sync + 'static {
    let app = app.clone();
    let job = job.to_string();
    let inst = inst.to_string();
    let last = Mutex::new((std::time::Instant::now() - std::time::Duration::from_secs(1), -1.0f32));
    move |pct: f32, label: &str| {
        let mut l = last.lock();
        if pct < 1.0 && l.0.elapsed().as_millis() < 80 && (pct - l.1).abs() < 0.05 {
            return;
        }
        *l = (std::time::Instant::now(), pct);
        let _ = app.emit("job", json!({ "job": job, "inst": inst, "pct": pct.clamp(0.0, 1.0), "label": label }));
    }
}

// ------------------------------------------------------------------ store (every kind)

#[tauri::command]
pub async fn store2_search(id: Option<String>, kind: String, query: String, offset: u32, limit: u32, sort: String, filters: Vec<Vec<String>>) -> R<Value> {
    blocking(move || {
        let loader = id.as_deref().and_then(prism::instance).map(|i| i.loader).unwrap_or_else(|| "fabric".into());
        store::search(&kind, &query, offset, limit, &sort, &filters, &loader).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn store2_project(id: Option<String>, kind: String, project: String) -> R<Value> {
    blocking(move || {
        let (loader, mc) = id.as_deref().and_then(prism::instance).map(|i| (i.loader, i.mc_version)).unwrap_or_default();
        store::project(&kind, &project, &loader, &mc).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn store2_install(state: State<'_, LState>, id: String, kind: String, project: String, world: Option<String>) -> R<Vec<String>> {
    let _g = state.busy()?;
    not_running(&id)?;
    blocking(move || {
        let i = inst(&id)?;
        store::install(&kind, &i, &project, world.as_deref()).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn saved_list() -> R<Vec<Value>> {
    blocking(|| Ok(store::saved())).await
}

#[tauri::command]
pub async fn saved_toggle(hit: Value) -> R<Vec<Value>> {
    blocking(move || store::saved_toggle(hit).map_err(err)).await
}

#[tauri::command]
pub async fn packs_list(id: String, kind: String) -> R<Vec<store::Pack>> {
    blocking(move || {
        let i = inst(&id)?;
        Ok(if kind == "shader" { store::shader_list(&i) } else { store::resource_packs(&mc_of(&i)) })
    })
    .await
}

#[tauri::command]
pub async fn pack_toggle(id: String, file: String, on: bool) -> R<()> {
    not_running(&id)?;
    blocking(move || store::set_resource_pack(&mc_of(&inst(&id)?), &file, on).map_err(err)).await
}

#[tauri::command]
pub async fn pack_use_shader(id: String, file: String) -> R<()> {
    blocking(move || perf::use_shader_pack(&inst(&id)?, &file).map_err(err)).await
}

#[tauri::command]
pub async fn pack_delete(id: String, kind: String, file: String) -> R<()> {
    not_running(&id)?;
    blocking(move || store::delete_pack(&mc_of(&inst(&id)?), &kind, &file).map_err(err)).await
}

// ------------------------------------------------------------------ instances

#[tauri::command]
pub async fn inst_versions() -> R<Vec<instances::McVersion>> {
    blocking(|| instances::mc_versions().map_err(err)).await
}

#[tauri::command]
pub async fn inst_loaders(mc: String) -> R<Vec<instances::LoaderChoice>> {
    blocking(move || Ok(instances::loaders_for(&mc))).await
}

#[tauri::command]
pub async fn inst_starter(mc: String, loader: String) -> R<Vec<Value>> {
    blocking(move || instances::starter_kit(&mc, &loader).map_err(err)).await
}

#[tauri::command]
pub async fn inst_items(state: State<'_, LState>) -> R<Vec<instances::ItemName>> {
    let a = state.assets()?;
    blocking(move || Ok(instances::items(&a))).await
}

#[tauri::command]
pub async fn inst_create(app: tauri::AppHandle, state: State<'_, LState>, spec: instances::NewInstance, job: String) -> R<Value> {
    let _g = state.busy()?;
    let a = state.assets.read().clone();
    let rep = reporter(&app, &job, "");
    blocking(move || instances::create(spec, a.as_deref(), &rep).map_err(err)).await
}

#[tauri::command]
pub async fn modpack_preview(src: instances::PackSource) -> R<Value> {
    blocking(move || instances::preview(&src).map_err(err)).await
}

#[tauri::command]
pub async fn modpack_install(app: tauri::AppHandle, state: State<'_, LState>, src: instances::PackSource, job: String) -> R<String> {
    let _g = state.busy()?;
    let rep = reporter(&app, &job, "");
    blocking(move || instances::install_pack(&src, &rep).map_err(err)).await
}

#[tauri::command]
pub async fn pack_file_kind(path: String) -> R<String> {
    blocking(move || instances::file_kind(&path).map(|s| s.to_string()).map_err(err)).await
}

#[tauri::command]
pub fn prism_import(path: String) -> R<()> {
    instances::prism_import(&path).map_err(err)
}

#[tauri::command]
pub async fn inst_export(app: tauri::AppHandle, id: String, job: String) -> R<String> {
    let rep = reporter(&app, &job, &id);
    blocking(move || instances::export(&inst(&id)?, &rep).map(|p| p.to_string_lossy().to_string()).map_err(err)).await
}

#[tauri::command]
pub async fn inst_duplicate(app: tauri::AppHandle, state: State<'_, LState>, id: String, name: String, with_worlds: bool, job: String) -> R<String> {
    let _g = state.busy()?;
    let rep = reporter(&app, &job, &id);
    blocking(move || instances::duplicate(&inst(&id)?, &name, with_worlds, &rep).map_err(err)).await
}

#[tauri::command]
pub async fn inst_rename(id: String, name: String) -> R<()> {
    blocking(move || instances::rename(&inst(&id)?, &name).map_err(err)).await
}

#[tauri::command]
pub async fn inst_delete(id: String) -> R<()> {
    not_running(&id)?;
    blocking(move || instances::delete(&inst(&id)?).map_err(err)).await
}

#[tauri::command]
pub async fn inst_set_icon(state: State<'_, LState>, id: String, item: Option<String>, file: Option<String>) -> R<String> {
    let a = state.assets.read().clone();
    blocking(move || {
        let i = inst(&id)?;
        let key = match (item, file, a) {
            (_, Some(f), _) => instances::icon_from_file(&f).map_err(err)?,
            (Some(it), _, Some(a)) => instances::icon_from_item(&a, &it).map_err(err)?,
            _ => return Err("pick an icon".into()),
        };
        instances::set_icon(&i, &key).map_err(err)?;
        Ok(key)
    })
    .await
}

#[tauri::command]
pub async fn inst_settings(id: String) -> R<Value> {
    blocking(move || Ok(instances::settings(&inst(&id)?))).await
}

#[tauri::command]
pub async fn inst_set_memory(id: String, mb: i64) -> R<()> {
    blocking(move || perf::set_memory(&inst(&id)?, mb).map_err(err)).await
}

#[tauri::command]
pub async fn inst_set_java(id: String, path: Option<String>) -> R<()> {
    blocking(move || instances::set_java(&inst(&id)?, path).map_err(err)).await
}

#[tauri::command]
pub async fn inst_upgrade_targets(id: String) -> R<Value> {
    blocking(move || Ok(instances::version_list(&inst(&id)?))).await
}

#[tauri::command]
pub async fn inst_upgrade_check(id: String, target: String) -> R<Value> {
    blocking(move || instances::upgrade_check(&inst(&id)?, &target).map_err(err)).await
}

#[tauri::command]
pub async fn inst_upgrade(app: tauri::AppHandle, state: State<'_, LState>, id: String, target: String, with_worlds: bool, job: String) -> R<String> {
    let _g = state.busy()?;
    let rep = reporter(&app, &job, &id);
    blocking(move || instances::upgrade(&inst(&id)?, &target, with_worlds, &rep).map_err(err)).await
}
