//! The 3D world's hands: collision for walking, picking the block under the mouse (signs, chests,
//! books, frames), opening doors and gates, hiding a chest while its lid animates, and the light
//! sources that glow at night. Everything here is in memory only; the save is never touched.

use crate::{dim_of, AppState, R};
use blockdata::{BlockState, Section};
use mcassets::Assets;
use mcworld::nbt::{text_of, V, Value};
use mcworld::Chunk;
use parking_lot::Mutex;
use serde_json::{json, Value as J};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use tauri::State;

/// Block changes made in the 3D view (open doors, hidden chests), per (dim, x, y, z).
static OV: LazyLock<Mutex<HashMap<(String, i32, i32, i32), BlockState>>> = LazyLock::new(Default::default);

fn ov_get(dim: &str, x: i32, y: i32, z: i32) -> Option<BlockState> {
    OV.lock().get(&(dim.to_string(), x, y, z)).cloned()
}

/// Copies of the sections that have view-only changes, for the mesher.
pub fn patched_sections(dim: &str, chunks: &HashMap<(i32, i32), Arc<Chunk>>) -> HashMap<(i32, i32, i32), Section> {
    let mut out: HashMap<(i32, i32, i32), Section> = HashMap::new();
    let ov = OV.lock();
    for ((d, x, y, z), st) in ov.iter() {
        if d != dim {
            continue;
        }
        let (cx, sy, cz) = (x >> 4, y >> 4, z >> 4);
        let Some(c) = chunks.get(&(cx, cz)) else { continue };
        let Some(sec) = c.section(sy) else { continue };
        let s = out.entry((cx, sy, cz)).or_insert_with(|| sec.clone());
        s.set((x & 15) as usize, (y & 15) as usize, (z & 15) as usize, st);
    }
    out
}

fn block_at(ctx: &crate::Ctx, dim: &str, x: i32, y: i32, z: i32) -> Option<BlockState> {
    if let Some(s) = ov_get(dim, x, y, z) {
        return Some(s);
    }
    let c = ctx.world.chunk(dim_of(dim), x >> 4, z >> 4)?;
    c.block((x & 15) as usize, y, (z & 15) as usize).cloned()
}

// ------------------------------------------------------------------ collision

/// 0 none, 1 full, 2 bottom half, 3 top half, 4 fence height (1.5), 6 water, 7 lava,
/// 8 climbable (ladder, vines), 9 thin floor (trapdoor, 3/16).
fn collide_class(st: &BlockState, assets: &Assets) -> u8 {
    if st.is_air() {
        return 0;
    }
    let n = st.short();
    let p = |k: &str| st.prop(k);
    match n {
        "water" | "bubble_column" => return 6,
        "lava" => return 7,
        "ladder" | "vine" | "scaffolding" | "cave_vines" | "cave_vines_plant" | "weeping_vines" | "weeping_vines_plant" | "twisting_vines" | "twisting_vines_plant" => return 8,
        "snow" => return if p("layers").and_then(|l| l.parse::<u8>().ok()).unwrap_or(1) >= 5 { 2 } else { 0 },
        "powder_snow" | "cobweb" | "fire" | "soul_fire" | "light" | "structure_void" | "nether_portal" | "end_portal" | "end_gateway" | "tripwire" | "string"
        | "redstone_wire" | "lever" | "lantern" | "soul_lantern" | "chain" | "end_rod" | "lightning_rod" | "pointed_dripstone" | "frogspawn" | "turtle_egg"
        | "sea_pickle" | "small_dripleaf" | "bamboo" | "bamboo_sapling" | "brewing_stand" | "bell" | "conduit" | "flower_pot" | "moving_piston"
        | "sculk_vein" | "lily_pad" | "nether_wart" | "big_dripleaf_stem" | "leaf_litter" | "cactus_flower" => return 0,
        "campfire" | "soul_campfire" | "cake" | "daylight_detector" | "stonecutter" => return 2,
        _ => {}
    }
    if n.ends_with("_door") {
        return if p("open") == Some("true") { 0 } else { 1 };
    }
    if n.ends_with("_trapdoor") {
        return if p("open") == Some("true") {
            0
        } else if p("half") == Some("top") {
            3
        } else {
            9
        };
    }
    if n.ends_with("fence_gate") {
        return if p("open") == Some("true") { 0 } else { 4 };
    }
    if n.ends_with("_fence") || n.ends_with("_wall") {
        return 4;
    }
    if n.ends_with("_slab") {
        return match p("type") {
            Some("bottom") => 2,
            Some("top") => 3,
            _ => 1,
        };
    }
    if n.ends_with("_bed") {
        return 2;
    }
    let thin = n.contains("carpet")
        || n.ends_with("pressure_plate")
        || n.contains("torch")
        || n.ends_with("sign")
        || n.ends_with("banner")
        || n.ends_with("button")
        || n.ends_with("rail")
        || n.starts_with("potted_")
        || (n.contains("candle") && !n.contains("cake"))
        || n.ends_with("_head")
        || n.ends_with("_skull")
        || n.ends_with("coral")
        || n.ends_with("coral_fan")
        || n.ends_with("_sapling")
        || n.ends_with("mushroom")
        || n.ends_with("_roots")
        || n.ends_with("_sprouts")
        || n.ends_with("_bud")
        || n == "amethyst_cluster"
        || n.ends_with("_fungus")
        || ((n.ends_with("_stem")) && (n.starts_with("melon") || n.starts_with("pumpkin") || n.starts_with("attached")))
        || mesher::is_plant(&st.name);
    if thin {
        return 0;
    }
    let b = assets.models.state(st);
    if b.fluid.is_some() && !b.visible {
        return 6;
    }
    if b.visible {
        1
    } else {
        0
    }
}

#[tauri::command]
pub async fn w_collide(state: State<'_, AppState>, dim: String, x: i32, y: i32, z: i32) -> R<tauri::ipc::Response> {
    let ctx = state.view()?;
    let assets = state.assets()?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let d = dim_of(&dim);
        let e = ctx.explored(d);
        let (x0, y0, z0) = (x - 16, y - 16, z - 16);
        let mut out = vec![0u8; 32 * 32 * 32];
        let mut cache: HashMap<BlockState, u8> = HashMap::new();
        let ov: Vec<((i32, i32, i32), BlockState)> = OV.lock().iter().filter(|(k, _)| k.0 == dim).map(|(k, v)| ((k.1, k.2, k.3), v.clone())).collect();
        for cz in (z0 >> 4)..=((z0 + 31) >> 4) {
            for cx in (x0 >> 4)..=((x0 + 31) >> 4) {
                let unseen = !e.seen.contains(&(cx, cz));
                let chunk = if unseen { None } else { ctx.world.chunk(d, cx, cz) };
                for lz in 0..16 {
                    for lx in 0..16 {
                        let wx = cx * 16 + lx;
                        let wz = cz * 16 + lz;
                        if wx < x0 || wx >= x0 + 32 || wz < z0 || wz >= z0 + 32 {
                            continue;
                        }
                        for wy in y0..y0 + 32 {
                            let v = match &chunk {
                                None => 1,
                                Some(c) => {
                                    if wy < d.min_y() {
                                        1
                                    } else {
                                        match c.block(lx as usize, wy, lz as usize) {
                                            Some(b) => *cache.entry(b.clone()).or_insert_with(|| collide_class(b, &assets)),
                                            None => 0,
                                        }
                                    }
                                }
                            };
                            let i = (((wy - y0) * 32 + (wz - z0)) * 32 + (wx - x0)) as usize;
                            out[i] = v;
                        }
                    }
                }
            }
        }
        for ((wx, wy, wz), st) in ov {
            if wx >= x0 && wx < x0 + 32 && wy >= y0 && wy < y0 + 32 && wz >= z0 && wz < z0 + 32 {
                let i = (((wy - y0) * 32 + (wz - z0)) * 32 + (wx - x0)) as usize;
                out[i] = collide_class(&st, &assets);
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(out))
}

// ------------------------------------------------------------------ picking

fn props_json(st: &BlockState) -> J {
    let mut m = serde_json::Map::new();
    for (k, v) in &st.props {
        m.insert(k.clone(), json!(v));
    }
    J::Object(m)
}

fn items_json(list: &[Value], assets: &Assets) -> Vec<J> {
    mcworld::items::items_of(list)
        .into_iter()
        .map(|it| {
            let name = it.name.clone().unwrap_or_else(|| assets.lang.name(&it.id));
            json!({ "slot": it.slot.unwrap_or(-1), "id": it.id, "count": it.count, "name": name, "custom": it.name.is_some(), "ench": it.enchants, "inner": it.contents.len() })
        })
        .collect()
}

fn page_text(p: &Value) -> String {
    if let Some(r) = p.get("raw") {
        return text_of(r);
    }
    if let Some(f) = p.get("filtered") {
        return text_of(f);
    }
    text_of(p)
}

fn book_json(item: &Value) -> Option<J> {
    let c = item.get("components")?;
    if let Some(w) = c.get("minecraft:written_book_content") {
        let title = w.get("title").map(page_text).unwrap_or_default();
        let author = w.get_str("author").unwrap_or("").to_string();
        let pages: Vec<String> = w.get_list("pages").iter().map(page_text).collect();
        return Some(json!({ "title": title, "author": author, "pages": pages }));
    }
    if let Some(w) = c.get("minecraft:writable_book_content") {
        let pages: Vec<String> = w.get_list("pages").iter().map(page_text).collect();
        return Some(json!({ "title": "Book and Quill", "author": "", "pages": pages }));
    }
    None
}

fn sign_side(v: Option<&Value>) -> J {
    let Some(v) = v else { return J::Null };
    let lines: Vec<String> = v.get_list("messages").iter().map(text_of).collect();
    json!({ "lines": lines, "color": v.get_str("color").unwrap_or("black"), "glow": v.get_i64("has_glowing_text").unwrap_or(0) != 0 })
}

/// The other half of a double chest.
fn chest_other(st: &BlockState, x: i32, y: i32, z: i32) -> Option<(i32, i32, i32)> {
    let t = st.prop("type")?;
    if t == "single" {
        return None;
    }
    // left joins clockwise of facing, right joins counter-clockwise
    let (dx, dz) = match (st.prop("facing").unwrap_or("north"), t) {
        ("north", "left") | ("south", "right") => (1, 0),
        ("north", _) | ("south", _) => (-1, 0),
        ("east", "left") | ("west", "right") => (0, 1),
        _ => (0, -1),
    };
    Some((x + dx, y, z + dz))
}

fn block_entity(c: &Chunk, x: i32, y: i32, z: i32) -> Option<Value> {
    c.block_entities.iter().find(|e| e.get_i64("x") == Some(x as i64) && e.get_i64("y") == Some(y as i64) && e.get_i64("z") == Some(z as i64)).cloned()
}

fn info(ctx: &crate::Ctx, assets: &Assets, dim: &str, x: i32, y: i32, z: i32, st: &BlockState) -> J {
    let n = st.short().to_string();
    let mut out = json!({ "pos": [x, y, z], "block": st.name, "props": props_json(st), "name": assets.lang.name(&st.name), "kind": "block" });
    let toggles = (n.ends_with("_door") && n != "iron_door") || (n.ends_with("_trapdoor") && n != "iron_trapdoor") || n.ends_with("fence_gate") || n == "lever";
    if toggles {
        out["kind"] = json!("toggle");
        out["open"] = json!(st.prop("open").or(st.prop("powered")) == Some("true"));
        return out;
    }
    let chunk = ctx.world.chunk(dim_of(dim), x >> 4, z >> 4);
    let be = chunk.as_ref().and_then(|c| block_entity(c, x, y, z));
    if let Some(name) = be.as_ref().and_then(|e| e.get("CustomName")).map(text_of).filter(|s| !s.is_empty()) {
        out["title"] = json!(name);
    }
    if n == "ender_chest" {
        let mut items = Vec::new();
        if let Some((_, p)) = ctx.world.players().into_iter().next() {
            items = items_json(p.get_list("EnderItems"), assets);
        }
        out["kind"] = json!("container");
        out["slots"] = json!(27);
        out["items"] = json!(items);
        out["anim"] = json!("chest");
        return out;
    }
    let Some(be) = be else { return out };
    let id = be.get_str("id").unwrap_or("").trim_start_matches("minecraft:").to_string();
    match id.as_str() {
        "sign" | "hanging_sign" => {
            out["kind"] = json!("sign");
            out["front"] = sign_side(be.get("front_text"));
            out["back"] = sign_side(be.get("back_text"));
            out["waxed"] = json!(be.get_i64("is_waxed").unwrap_or(0) != 0);
        }
        "lectern" => {
            out["kind"] = json!("book");
            out["book"] = be.get("Book").and_then(book_json).unwrap_or(J::Null);
            out["page"] = json!(be.get_i64("Page").unwrap_or(0));
        }
        "jukebox" => {
            out["kind"] = json!("jukebox");
            let rec = be.get("RecordItem").and_then(|r| r.get_str("id")).map(str::to_string);
            out["disc"] = json!(rec.as_ref().map(|r| json!({ "id": r, "name": assets.lang.name(r) })));
        }
        "mob_spawner" | "trial_spawner" => {
            out["kind"] = json!("spawner");
            let mob = be
                .path(&["SpawnData", "entity", "id"])
                .and_then(|v| v.str())
                .or_else(|| be.path(&["spawn_data", "entity", "id"]).and_then(|v| v.str()))
                .map(str::to_string);
            out["mob"] = json!(mob.map(|m| json!({ "id": m, "name": assets.lang.entity_name(&m) })));
        }
        "beacon" => {
            out["kind"] = json!("beacon");
            out["primary"] = json!(be.get_str("primary_effect"));
            out["secondary"] = json!(be.get_str("secondary_effect"));
        }
        "decorated_pot" => {
            out["kind"] = json!("container");
            out["slots"] = json!(1);
            let item = be.get("item").map(|i| items_json(std::slice::from_ref(i), assets)).unwrap_or_default();
            out["items"] = json!(item);
        }
        _ => {
            let list = be.get_list("Items");
            let slots = match id.as_str() {
                "hopper" => 5,
                "dispenser" | "dropper" | "crafter" => 9,
                "furnace" | "blast_furnace" | "smoker" => 3,
                "brewing_stand" => 5,
                "campfire" | "soul_campfire" => 4,
                "chiseled_bookshelf" => 6,
                "shelf" => 3,
                _ => 27,
            };
            let is_container = !list.is_empty()
                || matches!(id.as_str(), "chest" | "trapped_chest" | "barrel" | "shulker_box" | "hopper" | "dispenser" | "dropper" | "crafter" | "furnace" | "blast_furnace" | "smoker" | "brewing_stand")
                || id.ends_with("copper_chest");
            if !is_container {
                return out;
            }
            out["kind"] = json!("container");
            out["slots"] = json!(slots);
            let mut items = items_json(list, assets);
            if n == "chest" || n == "trapped_chest" || n.ends_with("copper_chest") {
                out["anim"] = json!("chest");
                if let Some((ox, oy, oz)) = chest_other(st, x, y, z) {
                    let other_items = ctx
                        .world
                        .chunk(dim_of(dim), ox >> 4, oz >> 4)
                        .and_then(|c| block_entity(&c, ox, oy, oz).map(|e| items_json(e.get_list("Items"), assets)))
                        .unwrap_or_default();
                    // the "right" half is the top 27 slots in game
                    let right_first = st.prop("type") == Some("right");
                    let (top, bottom) = if right_first { (items, other_items) } else { (other_items, items) };
                    let mut all = top;
                    for mut it in bottom {
                        it["slot"] = json!(it["slot"].as_i64().unwrap_or(0) + 27);
                        all.push(it);
                    }
                    items = all;
                    out["slots"] = json!(54);
                    out["other"] = json!([ox, oy, oz]);
                }
            } else if n.ends_with("shulker_box") {
                out["anim"] = json!("shulker");
            } else if n == "barrel" {
                out["anim"] = json!("barrel");
            }
            out["items"] = json!(items);
        }
    }
    out
}

/// Item frames (and glow frames) by block cell, from the storage index.
fn frames(ctx: &crate::Ctx, dim: &str) -> HashMap<(i32, i32, i32), J> {
    let mut out = HashMap::new();
    let Some(idx) = ctx.index.read().clone() else { return out };
    for c in &idx.containers {
        if c.dim != dim || !c.kind.contains("item_frame") {
            continue;
        }
        let item = c.items.first().map(|i| json!({ "id": i.id, "count": i.count, "name": i.name }));
        out.insert((c.pos[0], c.pos[1], c.pos[2]), json!({ "kind": "frame", "glow": c.kind.contains("glow"), "item": item, "pos": c.pos, "name": "Item Frame" }));
    }
    out
}

#[tauri::command]
pub async fn w_ray(state: State<'_, AppState>, dim: String, o: [f64; 3], d: [f64; 3], max: f64) -> R<J> {
    let ctx = state.view()?;
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-9);
        let dir = [d[0] / len, d[1] / len, d[2] / len];
        let mut cell = [o[0].floor() as i32, o[1].floor() as i32, o[2].floor() as i32];
        let step = [dir[0].signum() as i32, dir[1].signum() as i32, dir[2].signum() as i32];
        let tdelta = [1.0 / dir[0].abs().max(1e-9), 1.0 / dir[1].abs().max(1e-9), 1.0 / dir[2].abs().max(1e-9)];
        let mut tmax = [0.0; 3];
        for a in 0..3 {
            let b = if dir[a] > 0.0 { (cell[a] + 1) as f64 - o[a] } else { o[a] - cell[a] as f64 };
            tmax[a] = b * tdelta[a];
        }
        let fr = frames(&ctx, &dim);
        let e = ctx.explored(dim_of(&dim));
        let mut t = 0.0;
        let mut face = -1i32;
        while t <= max {
            if !e.seen.contains(&(cell[0] >> 4, cell[2] >> 4)) {
                return J::Null;
            }
            if let Some(f) = fr.get(&(cell[0], cell[1], cell[2])) {
                let mut f = f.clone();
                f["dist"] = json!(t);
                return f;
            }
            // the block the camera itself is inside (clipped into a wall) doesn't count
            let start = face < 0;
            if let Some(st) = if start { None } else { block_at(&ctx, &dim, cell[0], cell[1], cell[2]) } {
                let b = assets.models.state(&st);
                let sn = st.short();
                let skip = st.is_air() || (b.fluid.is_some() && !b.visible) || sn == "water" || sn == "lava" || sn == "light" || (mesher::is_plant(&st.name) && !sn.ends_with("vine"));
                if !skip && b.visible {
                    let mut out = info(&ctx, &assets, &dim, cell[0], cell[1], cell[2], &st);
                    out["dist"] = json!(t);
                    out["face"] = json!(face);
                    return out;
                }
            }
            let a = if tmax[0] < tmax[1] {
                if tmax[0] < tmax[2] {
                    0
                } else {
                    2
                }
            } else if tmax[1] < tmax[2] {
                1
            } else {
                2
            };
            cell[a] += step[a];
            t = tmax[a];
            tmax[a] += tdelta[a];
            face = a as i32 * 2 + if step[a] > 0 { 0 } else { 1 };
        }
        J::Null
    })
    .await
    .map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ view-only changes

/// Open or close a door, trapdoor, fence gate or lever in the view. Returns the blocks that changed.
#[tauri::command]
pub async fn w_toggle(state: State<'_, AppState>, dim: String, x: i32, y: i32, z: i32) -> R<J> {
    let ctx = state.view()?;
    let st = block_at(&ctx, &dim, x, y, z).ok_or("Nothing there")?;
    let n = st.short().to_string();
    let key = if n == "lever" { "powered" } else { "open" };
    let open = st.prop(key) == Some("true");
    let flip = |s: &BlockState| -> BlockState {
        let mut s = s.clone();
        let v = if open { "false" } else { "true" };
        if let Some(p) = s.props.iter_mut().find(|(k, _)| k == key) {
            p.1 = v.to_string();
        } else {
            s.props.push((key.to_string(), v.to_string()));
        }
        s
    };
    let mut changed = vec![(x, y, z, flip(&st))];
    if n.ends_with("_door") {
        let oy = if st.prop("half") == Some("upper") { y - 1 } else { y + 1 };
        if let Some(o) = block_at(&ctx, &dim, x, oy, z) {
            if o.name == st.name {
                changed.push((x, oy, z, flip(&o)));
            }
        }
    }
    let mut ov = OV.lock();
    for (cx, cy, cz, s) in &changed {
        ov.insert((dim.clone(), *cx, *cy, *cz), s.clone());
    }
    Ok(json!({ "open": !open, "changed": changed.iter().map(|c| [c.0, c.1, c.2]).collect::<Vec<_>>() }))
}

/// Hide blocks (a chest while its animated lid is shown) or bring them back.
#[tauri::command]
pub async fn w_hide(dim: String, at: Vec<[i32; 3]>, hide: bool) -> R<()> {
    let mut ov = OV.lock();
    for p in at {
        let k = (dim.clone(), p[0], p[1], p[2]);
        if hide {
            ov.insert(k, BlockState::new("minecraft:air"));
        } else if ov.get(&k).map(|s| s.is_air()).unwrap_or(false) {
            ov.remove(&k);
        }
    }
    Ok(())
}

/// Put every view-only change back (leaving the 3D page). Returns where things changed.
#[tauri::command]
pub fn w_clear() -> Vec<[i32; 3]> {
    let mut ov = OV.lock();
    let out = ov.keys().map(|k| [k.1, k.2, k.3]).collect();
    ov.clear();
    out
}

// ------------------------------------------------------------------ lights

/// (colour kind, light level) for light-giving blocks worth a glow.
/// kinds: 0 warm flame, 1 soul, 2 lamp yellow, 3 sea lantern, 4 redstone, 5 end rod, 6 ochre, 7 verdant, 8 pearlescent, 9 copper
fn light_of(st: &BlockState) -> Option<(u8, u8)> {
    let n = st.short();
    let lit = st.prop("lit") != Some("false");
    let on = st.prop("lit") == Some("true");
    Some(match n {
        "torch" | "wall_torch" => (0, 14),
        "lantern" | "jack_o_lantern" => (0, 15),
        "campfire" if lit => (0, 15),
        "furnace" | "blast_furnace" | "smoker" if on => (0, 13),
        "soul_torch" | "soul_wall_torch" | "soul_lantern" => (1, 10),
        "soul_campfire" if lit => (1, 10),
        "glowstone" | "shroomlight" => (2, 15),
        "redstone_lamp" if on => (2, 15),
        "sea_lantern" | "beacon" | "conduit" => (3, 15),
        "redstone_torch" | "redstone_wall_torch" if lit => (4, 7),
        "end_rod" => (5, 14),
        "ochre_froglight" => (6, 15),
        "verdant_froglight" => (7, 15),
        "pearlescent_froglight" => (8, 15),
        "copper_torch" | "copper_wall_torch" => (9, 14),
        x if x.ends_with("copper_lantern") => (9, 15),
        x if x.ends_with("copper_bulb") && on => (2, 15),
        x if x.ends_with("candle") && on => (0, 3 * st.prop("candles").and_then(|c| c.parse::<u8>().ok()).unwrap_or(1)),
        _ => return None,
    })
}

#[tauri::command]
pub async fn w_lights(state: State<'_, AppState>, dim: String, chunks: Vec<[i32; 2]>) -> R<Vec<[i32; 5]>> {
    let ctx = state.view()?;
    tauri::async_runtime::spawn_blocking(move || {
        let d = dim_of(&dim);
        let e = ctx.explored(d);
        let mut out = Vec::new();
        for [cx, cz] in chunks {
            if !e.seen.contains(&(cx, cz)) {
                continue;
            }
            let Some(c) = ctx.world.chunk(d, cx, cz) else { continue };
            let mut n = 0;
            'sec: for (i, s) in c.sections.iter().enumerate() {
                let Some(s) = s else { continue };
                let lights: Vec<Option<(u8, u8)>> = s.palette.iter().map(light_of).collect();
                if lights.iter().all(|l| l.is_none()) {
                    continue;
                }
                let sy = c.min_section + i as i32;
                for (bi, &pi) in s.data.iter().enumerate() {
                    if let Some(Some((k, lv))) = lights.get(pi as usize) {
                        let (x, z, y) = (bi & 15, (bi >> 4) & 15, bi >> 8);
                        out.push([cx * 16 + x as i32, sy * 16 + y as i32, cz * 16 + z as i32, *k as i32, *lv as i32]);
                        n += 1;
                        if n > 400 {
                            break 'sec;
                        }
                    }
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}
