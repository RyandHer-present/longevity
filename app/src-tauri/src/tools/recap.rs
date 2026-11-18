//! After you quit the game: a recap of the session (time, distance, mined, kills, deaths, new
//! advancements, new Dex cards, goals finished). It's saved in the app and also slides in as a
//! small card at the corner of the desktop, which stays until you click it.
//! A snapshot of the stats is taken when the game starts, so the recap is an exact difference.

use super::{now, read_json, write_json, R};
use crate::{AppState, Ctx};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const DIST_KEYS: [&str; 9] = [
    "minecraft:walk_one_cm",
    "minecraft:sprint_one_cm",
    "minecraft:crouch_one_cm",
    "minecraft:swim_one_cm",
    "minecraft:fly_one_cm",
    "minecraft:aviate_one_cm",
    "minecraft:boat_one_cm",
    "minecraft:horse_one_cm",
    "minecraft:walk_under_water_one_cm",
];

fn snapshot_of(world: &mcworld::World) -> Option<Value> {
    let (uuid, _) = world.players().into_iter().next()?;
    let stats = world.stats_json(&uuid).and_then(|s| s.get("stats").cloned()).unwrap_or(json!({}));
    let adv: Vec<String> = world
        .advancements_json(&uuid)
        .and_then(|a| a.as_object().cloned())
        .map(|m| m.into_iter().filter(|(k, v)| !k.contains(":recipes/") && v.get("done").and_then(|d| d.as_bool()).unwrap_or(false)).map(|(k, _)| k).collect())
        .unwrap_or_default();
    let day = world.level().map(|l| l.day()).unwrap_or(0);
    Some(json!({ "t": now(), "day": day, "stats": stats, "adv": adv }))
}

fn instance_saves(instance: &str) -> Option<PathBuf> {
    let i = crate::launcher::prism::instance(instance)?;
    Some(PathBuf::from(i.mc_dir).join("saves"))
}

/// When a game starts: remember every world's stats in that instance.
pub fn before_game(instance: &str) {
    let Some(saves) = instance_saves(instance) else { return };
    let Ok(rd) = std::fs::read_dir(&saves) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.join("level.dat").exists() {
            continue;
        }
        if let Ok(w) = mcworld::World::open(&p) {
            if let Some(s) = snapshot_of(&w) {
                let _ = write_json(&atlascore::world_dir(&p).join("recap-snapshot.json"), &s);
            }
        }
    }
}

fn sum_map(v: &Value) -> i64 {
    v.as_object().map(|m| m.values().filter_map(|x| x.as_i64()).sum()).unwrap_or(0)
}

/// (id, delta) for every key that went up, biggest first.
fn diff_map(new: &Value, old: &Value) -> Vec<(String, i64)> {
    let mut out: Vec<(String, i64)> = new
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0) - old.get(k).and_then(|x| x.as_i64()).unwrap_or(0))).filter(|x| x.1 > 0).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

fn build(ctx: &Ctx, assets: &mcassets::Assets, before: &Value, after: &Value, wall_minutes: i64, crashed: bool, new_cards: usize, goals: &[String]) -> Value {
    let s1 = &after["stats"];
    let s0 = &before["stats"];
    let c = |s: &Value, k: &str| s.pointer(&format!("/minecraft:custom/{}", k.replace('/', "~1"))).and_then(|v| v.as_i64()).unwrap_or(0);
    let play = (c(s1, "minecraft:play_time") - c(s0, "minecraft:play_time")).max(0);
    let minutes = if play > 0 { play / 1200 } else { wall_minutes };
    let dist_cm: i64 = DIST_KEYS.iter().map(|k| (c(s1, k) - c(s0, k)).max(0)).sum();
    let mined = diff_map(&s1["minecraft:mined"], &s0["minecraft:mined"]);
    let killed = diff_map(&s1["minecraft:killed"], &s0["minecraft:killed"]);
    let crafted = diff_map(&s1["minecraft:crafted"], &s0["minecraft:crafted"]);
    let deaths = (c(s1, "minecraft:deaths") - c(s0, "minecraft:deaths")).max(0);
    let old_adv: Vec<String> = before["adv"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let new_adv: Vec<String> = after["adv"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).filter(|k| !old_adv.contains(k)).collect()).unwrap_or_default();
    let adv_names: Vec<String> = new_adv.iter().map(|k| assets.lang.advancement_title(k).unwrap_or_else(|| k.rsplit('/').next().unwrap_or(k).replace('_', " "))).collect();
    let name = |id: &str| assets.lang.name(id);
    let top = |l: &[(String, i64)]| l.first().map(|(id, n)| json!({ "id": id, "name": name(id), "count": n }));
    let days = after["day"].as_i64().unwrap_or(0) - before["day"].as_i64().unwrap_or(0);
    let mut lines: Vec<String> = Vec::new();
    for g in goals {
        lines.push(format!("Goal done: {g}"));
    }
    for a in adv_names.iter().take(3) {
        lines.push(format!("Advancement: {a}"));
    }
    if new_cards > 0 {
        lines.push(format!("{new_cards} new Dex card{}", if new_cards == 1 { "" } else { "s" }));
    }
    let headline = if crashed {
        "The game crashed".to_string()
    } else if let Some(g) = goals.first() {
        format!("You finished {g}")
    } else if let Some(a) = adv_names.first() {
        format!("You got {a}")
    } else if let Some((id, n)) = killed.first().filter(|k| k.1 >= 10) {
        format!("{n} {} down", name(id))
    } else if dist_cm > 500_000 {
        format!("{} km travelled", (dist_cm as f64 / 100_000.0 * 10.0).round() / 10.0)
    } else if let Some((id, n)) = mined.first() {
        format!("{n} {} mined", name(id))
    } else {
        "Session saved".to_string()
    };
    json!({
        "id": format!("r{}", now()),
        "t": now(),
        "world": ctx.entry.name,
        "world_path": ctx.entry.path.to_string_lossy(),
        "day": after["day"],
        "days_passed": days.max(0),
        "minutes": minutes,
        "crashed": crashed,
        "headline": headline,
        "lines": lines,
        "distance_m": dist_cm / 100,
        "mined": mined.iter().map(|x| x.1).sum::<i64>(),
        "mined_top": top(&mined),
        "killed": killed.iter().map(|x| x.1).sum::<i64>(),
        "killed_top": top(&killed),
        "kills": killed.iter().take(8).map(|(id, n)| json!({ "id": id, "name": name(id), "count": n })).collect::<Vec<_>>(),
        "crafted": crafted.iter().map(|x| x.1).sum::<i64>(),
        "crafted_top": top(&crafted),
        "deaths": deaths,
        "advancements": adv_names,
        "new_cards": new_cards,
        "goals": goals,
        "picked_up": sum_map(&s1["minecraft:picked_up"]) - sum_map(&s0["minecraft:picked_up"]),
        "traded": (c(s1, "minecraft:traded_with_villager") - c(s0, "minecraft:traded_with_villager")).max(0),
        "bred": (c(s1, "minecraft:animals_bred") - c(s0, "minecraft:animals_bred")).max(0),
        "seen": false,
    })
}

fn recaps_path(dir: &Path) -> PathBuf {
    dir.join("recaps.json")
}

pub fn list(ctx: &Ctx) -> Value {
    read_json(&recaps_path(&ctx.dir)).unwrap_or(json!({ "recaps": [] }))
}

fn save_recap(dir: &Path, r: &Value) {
    let p = recaps_path(dir);
    let mut all = read_json(&p).unwrap_or(json!({ "recaps": [] }));
    if let Some(a) = all["recaps"].as_array_mut() {
        a.insert(0, r.clone());
        a.truncate(150);
    }
    let _ = write_json(&p, &all);
}

/// The newest unseen recap across worlds (for the corner card).
fn latest_unseen() -> Option<(PathBuf, Value)> {
    let worlds = atlascore::data_dir().join("worlds");
    let mut best: Option<(PathBuf, Value)> = None;
    for e in std::fs::read_dir(worlds).ok()?.flatten() {
        let Some(v) = read_json(&recaps_path(&e.path())) else { continue };
        if let Some(r) = v["recaps"].as_array().and_then(|a| a.first()) {
            if r["seen"].as_bool() == Some(false) && best.as_ref().map(|b| b.1["t"].as_i64() < r["t"].as_i64()).unwrap_or(true) {
                best = Some((e.path(), r.clone()));
            }
        }
    }
    best
}

/// Test runs only: make a recap for one world right now (the off-screen tour uses it to check
/// the card window). Never available in normal use.
#[tauri::command]
pub async fn t_recap_test(app: AppHandle, path: String, minutes: i64) -> R<()> {
    if !crate::app::testing() {
        return Err("only in test runs".into());
    }
    std::thread::spawn(move || recap_worlds(&app, vec![PathBuf::from(path)], minutes, false));
    Ok(())
}

/// A recap the card window asked the main window to open (picked up when the main window loads).
static PENDING: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The recap card was clicked: mark it seen, close the card, open Longevity on that recap.
#[tauri::command]
pub async fn t_recap_open(app: AppHandle, id: String) -> R<()> {
    *PENDING.lock().unwrap() = Some(id.clone());
    let _ = mark_seen(&app, &id);
    crate::app::show(&app);
    let _ = app.emit_to("main", "open-recap", json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn t_take_recap() -> Option<String> {
    PENDING.lock().unwrap().take()
}

#[tauri::command]
pub async fn t_recap_latest() -> R<Value> {
    Ok(latest_unseen().map(|x| x.1).unwrap_or(Value::Null))
}

pub fn mark_seen(app: &AppHandle, id: &str) -> R<()> {
    let worlds = atlascore::data_dir().join("worlds");
    if let Ok(rd) = std::fs::read_dir(worlds) {
        for e in rd.flatten() {
            let p = recaps_path(&e.path());
            let Some(mut v) = read_json(&p) else { continue };
            let mut hit = false;
            if let Some(a) = v["recaps"].as_array_mut() {
                for r in a.iter_mut() {
                    if r["id"].as_str() == Some(id) {
                        r["seen"] = json!(true);
                        hit = true;
                    }
                }
            }
            if hit {
                let _ = write_json(&p, &v);
            }
        }
    }
    if let Some(w) = app.get_webview_window("recap") {
        let _ = w.destroy();
    }
    Ok(())
}

/// Open the small card at the bottom-right of the desktop (on its own thread: creating a window
/// from some callbacks deadlocks).
pub fn show_card(app: &AppHandle) {
    if app.get_webview_window("recap").is_some() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let (w, h) = (400.0, 196.0);
        let mut x = 0.0;
        let mut y = 0.0;
        if crate::app::testing() {
            x = -5200.0;
            y = -5200.0;
        } else if let Ok(Some(m)) = app.primary_monitor() {
            let s = m.scale_factor();
            let wa = m.work_area();
            x = (wa.position.x as f64 + wa.size.width as f64) / s - w - 16.0;
            y = (wa.position.y as f64 + wa.size.height as f64) / s - h - 16.0;
        }
        let _ = tauri::WebviewWindowBuilder::new(&app, "recap", tauri::WebviewUrl::App("index.html#recap".into()))
            .title("Longevity recap")
            .inner_size(w, h)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(true)
            .additional_browser_args(&crate::app::browser_args(&app))
            .build();
    });
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn setting_on(key: &str) -> bool {
    atlascore::Settings::load().extra.get(key).and_then(|v| v.as_bool()).unwrap_or(true)
}

pub fn after_game(app: &AppHandle, instance: &str, started_ms: i64, crashed: bool) {
    let Some(saves) = instance_saves(instance) else { return };
    // the world(s) played this session: level.dat written after the game started
    let mut played: Vec<PathBuf> = std::fs::read_dir(&saves)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| mcworld::world::mtime_ms(&p.join("level.dat")) > started_ms).collect())
        .unwrap_or_default();
    played.sort_by_key(|p| -mcworld::world::mtime_ms(&p.join("level.dat")));
    let wall = ((now() - started_ms) / 60000).max(0);
    recap_worlds(app, played, wall, crashed);
}

fn recap_worlds(app: &AppHandle, played: Vec<PathBuf>, wall: i64, crashed: bool) {
    let state = app.state::<AppState>();
    let Ok(assets) = state.assets() else { return };
    let open_path = state.world.read().as_ref().map(|c| c.entry.path.clone());
    let mut shown = false;
    for p in played.into_iter().take(2) {
        let Ok(ctx) = crate::make_ctx(&p) else { continue };
        // refresh what the app shows for this world: explored map, storage index, tool files
        ctx.rebuild_index();
        super::on_index_built(&ctx, Some(&assets));
        if open_path.as_deref() == Some(p.as_path()) {
            *state.world.write() = Some(ctx.clone());
            let _ = app.emit("world-refreshed", json!({ "path": p.to_string_lossy() }));
        }
        let Some(after) = snapshot_of(&ctx.world) else { continue };
        let before = read_json(&ctx.dir.join("recap-snapshot.json")).unwrap_or_else(|| after.clone());
        let sessions = ctx.sessions(&assets);
        let dex = crate::dex::compute(&ctx, &assets, &sessions);
        // cards unlocked but not opened in a pack yet, across every Dex list
        let new_cards = dex.as_object().map(|o| o.values().filter_map(|v| v.as_array()).flatten().filter(|c| c["new"].as_bool().unwrap_or(false)).count()).unwrap_or(0);
        let goals = super::projects::newly_done(&ctx, &assets);
        let r = build(&ctx, &assets, &before, &after, wall, crashed, new_cards, &goals);
        save_recap(&ctx.dir, &r);
        let _ = write_json(&ctx.dir.join("recap-snapshot.json"), &after);
        if setting_on("notify_goals") {
            for g in &goals {
                notify(app, "Goal done", &format!("{g} is complete in {}.", ctx.entry.name));
            }
        }
        shown = true;
        let _ = app.emit("recap-new", &r);
    }
    if shown {
        show_card(app);
    }
}

/// Once a day in the evening: if you have a streak going and haven't played today, a reminder.
pub fn streak_watch(app: AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(600));
        if !setting_on("notify_streak") {
            continue;
        }
        let local_secs = now() / 1000 + crate::launcher::history::local_offset_secs();
        let hour = (local_secs.rem_euclid(86400)) / 3600;
        if hour < 19 {
            continue;
        }
        let today = crate::launcher::history::today();
        let marker = atlascore::data_dir().join("streak-reminded");
        if std::fs::read_to_string(&marker).ok().as_deref() == Some(today.as_str()) {
            continue;
        }
        let sessions = crate::launcher::history::sessions();
        let mut days: Vec<String> = sessions.iter().filter(|s| s.minutes >= 5).map(|s| s.date.clone()).collect();
        days.sort();
        days.dedup();
        if days.last() == Some(&today) {
            continue;
        }
        // count back the run of days ending yesterday
        let mut streak = 0;
        let mut d = local_secs.div_euclid(86400) - 1;
        loop {
            let ds = date_of_days(d);
            if days.binary_search(&ds).is_ok() {
                streak += 1;
                d -= 1;
            } else {
                break;
            }
        }
        if streak >= 2 {
            notify(&app, &format!("{streak}-day streak"), "You haven't played today yet. Hop on to keep it going.");
            let _ = std::fs::write(&marker, &today);
        }
    }
}

fn date_of_days(days: i64) -> String {
    // civil-from-days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}
