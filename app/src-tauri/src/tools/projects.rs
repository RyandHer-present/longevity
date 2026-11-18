//! Project Planner storage: your goals (ready-made or your own), how much of each item you already
//! have across chests, shulkers, inventory and ender chest, and the pinned ones for the in-game
//! checklist. Goal templates and "where to get it" live on the page (they use the game data).

use super::{now, read_json, write_json, R};
use crate::Ctx;
use mcassets::Assets;
use serde_json::{json, Value};
use std::collections::HashMap;

fn path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.dir.join("projects.json")
}

pub fn raw(ctx: &Ctx) -> Value {
    read_json(&path(ctx)).unwrap_or(json!({ "projects": [] }))
}

fn have_map(ctx: &Ctx) -> HashMap<String, i64> {
    let mut m = HashMap::new();
    if let Some(idx) = ctx.index.read().clone() {
        for (id, n, _) in crate::search::totals(&idx) {
            m.insert(id, n);
        }
    }
    m
}

/// Every project with have/need filled in and a 0..1 progress.
pub fn list(ctx: &Ctx, assets: &Assets) -> Value {
    let mut r = raw(ctx);
    let have = have_map(ctx);
    if let Some(list) = r["projects"].as_array_mut() {
        for p in list.iter_mut() {
            let (mut got, mut need) = (0f64, 0f64);
            if let Some(items) = p["items"].as_array_mut() {
                for it in items.iter_mut() {
                    let id = it["id"].as_str().unwrap_or("").to_string();
                    let n = it["need"].as_i64().unwrap_or(1).max(1);
                    let h = have.get(&id).copied().unwrap_or(0) + it["manual"].as_i64().unwrap_or(0);
                    it["have"] = json!(h);
                    if it["name"].is_null() {
                        it["name"] = json!(assets.lang.name(&id));
                    }
                    got += (h.min(n)) as f64;
                    need += n as f64;
                }
            }
            p["progress"] = json!(if need > 0.0 { got / need } else { 0.0 });
        }
    }
    r
}

pub fn save(ctx: &Ctx, assets: &Assets, projects: Value) -> R<Value> {
    let mut v = json!({ "projects": projects });
    // strip computed fields before saving
    if let Some(list) = v["projects"].as_array_mut() {
        for p in list.iter_mut() {
            if let Some(o) = p.as_object_mut() {
                o.remove("progress");
            }
            if let Some(items) = p["items"].as_array_mut() {
                for it in items.iter_mut() {
                    if let Some(o) = it.as_object_mut() {
                        o.remove("have");
                    }
                }
            }
        }
    }
    write_json(&path(ctx), &v)?;
    write_for_game(ctx, assets);
    Ok(list(ctx, assets))
}

/// longevity-projects.json: pinned goals for the in-game checklist (the mod adds what you pick up
/// after "t" on top of "have").
pub fn write_for_game(ctx: &Ctx, assets: &Assets) {
    let l = list(ctx, assets);
    let projects: Vec<Value> = l["projects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|p| json!({ "id": p["id"], "name": p["name"], "pinned": p["pinned"].as_bool().unwrap_or(false), "items": p["items"] }))
        .collect();
    // pins the player changed in game win over ours
    let pins = read_json(&ctx.dir.join("companion-projects-pins.json")).and_then(|v| v.get("pinned").cloned());
    let projects: Vec<Value> = match pins.and_then(|v| v.as_array().cloned()) {
        Some(p) => projects
            .into_iter()
            .map(|mut x| {
                x["pinned"] = json!(p.iter().any(|id| id == &x["id"]));
                x
            })
            .collect(),
        None => projects,
    };
    let _ = write_json(&ctx.dir.join("longevity-projects.json"), &json!({ "t": now(), "projects": projects }));
}

/// Goals that just became complete (for the "goal done" notification), marked so they only fire once.
pub fn newly_done(ctx: &Ctx, assets: &Assets) -> Vec<String> {
    let l = list(ctx, assets);
    let mut r = raw(ctx);
    let mut done = Vec::new();
    if let (Some(computed), Some(stored)) = (l["projects"].as_array(), r["projects"].as_array_mut()) {
        for (c, s) in computed.iter().zip(stored.iter_mut()) {
            let complete = c["progress"].as_f64().unwrap_or(0.0) >= 0.9999;
            if complete && s["done_at"].is_null() {
                s["done_at"] = json!(now());
                done.push(c["name"].as_str().unwrap_or("A goal").to_string());
            }
        }
    }
    if !done.is_empty() {
        let _ = write_json(&path(ctx), &r);
    }
    done
}
