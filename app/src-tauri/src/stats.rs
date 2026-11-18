//! Player statistics, advancements with dates, play sessions from the logs, and day estimates.

use atlascore::events::Event;
use atlascore::logs::Session;
use mcassets::Lang;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Serialize, Clone)]
pub struct Advancement {
    pub id: String,
    pub title: String,
    pub description: String,
    pub done_ms: i64,
    pub frame: String,
}

pub fn parse_mc_date(s: &str) -> Option<i64> {
    // "2026-11-13 18:44:01 -0500"
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let d: Vec<i64> = parts[0].split('-').filter_map(|x| x.parse().ok()).collect();
    let t: Vec<i64> = parts[1].split(':').filter_map(|x| x.parse().ok()).collect();
    if d.len() != 3 || t.len() != 3 {
        return None;
    }
    let off = parts.get(2).and_then(|o| {
        let sign = if o.starts_with('-') { -1 } else { 1 };
        let o = o.trim_start_matches(['+', '-']);
        let h: i64 = o.get(0..2)?.parse().ok()?;
        let m: i64 = o.get(2..4)?.parse().ok()?;
        Some(sign * (h * 60 + m))
    });
    let (y, m, dd) = (d[0], d[1], d[2]);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dd - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + t[0] * 3600 + t[1] * 60 + t[2] - off.unwrap_or(0) * 60;
    Some(secs * 1000)
}

const FRAMES: &[(&str, &str)] = &[
    ("story/follow_ender_eye", "goal"),
    ("end/kill_dragon", "goal"),
    ("nether/all_effects", "challenge"),
    ("adventure/adventuring_time", "challenge"),
    ("husbandry/balanced_diet", "challenge"),
    ("nether/return_to_sender", "challenge"),
    ("adventure/kill_all_mobs", "challenge"),
    ("adventure/arbalistic", "challenge"),
    ("husbandry/complete_catalogue", "challenge"),
    ("end/levitate", "challenge"),
    ("nether/create_full_beacon", "goal"),
];

pub fn advancements(adv: &Value, lang: &Lang) -> Vec<Advancement> {
    let mut out = Vec::new();
    let Some(obj) = adv.as_object() else { return out };
    for (id, v) in obj {
        if id.contains(":recipes/") || id == "DataVersion" {
            continue;
        }
        if !v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
            continue;
        }
        let done = v.get("criteria").and_then(|c| c.as_object()).map(|c| c.values().filter_map(|d| d.as_str()).filter_map(parse_mc_date).max().unwrap_or(0)).unwrap_or(0);
        let Some(title) = lang.advancement_title(id) else { continue };
        let path = id.split_once(':').map(|p| p.1).unwrap_or(id);
        let frame = FRAMES.iter().find(|(p, _)| *p == path).map(|(_, f)| f.to_string()).unwrap_or_else(|| "task".into());
        out.push(Advancement { id: id.clone(), title, description: lang.advancement_description(id).unwrap_or_default(), done_ms: done, frame });
    }
    out.sort_by_key(|a| a.done_ms);
    out
}

fn top(map: Option<&Value>, n: usize) -> Vec<(String, i64)> {
    let mut v: Vec<(String, i64)> = map.and_then(|m| m.as_object()).map(|o| o.iter().filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n))).collect()).unwrap_or_default();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.truncate(n);
    v
}

/// Compact summary of the stats file.
pub fn summary(stats: &Value) -> Value {
    let s = stats.get("stats").cloned().unwrap_or(Value::Null);
    let custom = s.get("minecraft:custom").cloned().unwrap_or(Value::Null);
    let c = |k: &str| custom.get(format!("minecraft:{k}")).and_then(|v| v.as_i64()).unwrap_or(0);
    let cm = |k: &str| c(k) as f64 / 100.0; // cm -> blocks
    let sum = |m: &str| s.get(m).and_then(|m| m.as_object()).map(|o| o.values().filter_map(|v| v.as_i64()).sum::<i64>()).unwrap_or(0);
    json!({
        "play_ticks": c("play_time"),
        "total_world_ticks": c("total_world_time"),
        "deaths": c("deaths"),
        "mob_kills": c("mob_kills"),
        "player_kills": c("player_kills"),
        "damage_dealt": c("damage_dealt") as f64 / 10.0,
        "damage_taken": c("damage_taken") as f64 / 10.0,
        "jumps": c("jump"),
        "sleeps": c("sleep_in_bed"),
        "trades": c("traded_with_villager"),
        "bred": c("animals_bred"),
        "fish": c("fish_caught"),
        "enchanted": c("enchant_item"),
        "since_death_ticks": c("time_since_death"),
        "since_rest_ticks": c("time_since_rest"),
        "chests_opened": c("open_chest"),
        "distance": {
            "walk": cm("walk_one_cm"), "sprint": cm("sprint_one_cm"), "crouch": cm("crouch_one_cm"),
            "swim": cm("swim_one_cm"), "walk_on_water": cm("walk_on_water_one_cm"), "walk_under_water": cm("walk_under_water_one_cm"),
            "fall": cm("fall_one_cm"), "climb": cm("climb_one_cm"), "fly": cm("fly_one_cm"), "elytra": cm("aviate_one_cm"),
            "boat": cm("boat_one_cm"), "horse": cm("horse_one_cm"), "minecart": cm("minecart_one_cm"), "pig": cm("pig_one_cm"),
            "strider": cm("strider_one_cm"), "happy_ghast": cm("happy_ghast_one_cm"), "nautilus": cm("nautilus_one_cm")
        },
        "mined_total": sum("minecraft:mined"),
        "crafted_total": sum("minecraft:crafted"),
        "placed_total": sum("minecraft:used"),
        "top_mined": top(s.get("minecraft:mined"), 16),
        "top_crafted": top(s.get("minecraft:crafted"), 16),
        "top_used": top(s.get("minecraft:used"), 16),
        "top_killed": top(s.get("minecraft:killed"), 16),
        "top_killed_by": top(s.get("minecraft:killed_by"), 8),
        "top_picked_up": top(s.get("minecraft:picked_up"), 12),
        "top_broken": top(s.get("minecraft:broken"), 8),
    })
}

/// Sessions from the logs that belong to this world: same level name and a login inside chunks this
/// world's player has visited (several worlds can share a level name).
pub fn sessions_for_world(all: &[Session], level_name: &str, visited: &dyn Fn(f64, f64) -> bool) -> Vec<Session> {
    all.iter()
        .filter(|s| s.level == level_name)
        .filter(|s| match s.login_pos {
            Some(p) => visited(p[0], p[2]),
            None => true,
        })
        .cloned()
        .collect()
}

/// Map real time to an in-game day using the sessions: game time only advances while playing,
/// so spread the world's current day count over the cumulative play time.
pub struct DayClock {
    spans: Vec<(i64, i64, f64)>, // start, end, cumulative ms before start
    total_ms: f64,
    now_day: f64,
}

impl DayClock {
    pub fn new(sessions: &[Session], world_day_time_ticks: i64) -> DayClock {
        let mut spans = Vec::new();
        let mut cum = 0.0;
        let mut ss: Vec<&Session> = sessions.iter().collect();
        ss.sort_by_key(|s| s.start);
        for s in ss {
            let len = (s.end - s.start).max(0) as f64;
            spans.push((s.start, s.end, cum));
            cum += len;
        }
        DayClock { spans, total_ms: cum.max(1.0), now_day: world_day_time_ticks as f64 / 24000.0 }
    }
    pub fn day_at(&self, t: i64) -> f64 {
        let mut played = self.total_ms;
        for (s, e, cum) in &self.spans {
            if t < *s {
                played = *cum;
                break;
            }
            if t <= *e {
                played = cum + (t - s) as f64;
                break;
            }
        }
        (played / self.total_ms * self.now_day).clamp(0.0, self.now_day)
    }
}

pub fn session_events(sessions: &[Session], clock: &DayClock) -> Vec<Event> {
    let mut out = Vec::new();
    for s in sessions {
        out.push(Event {
            t: s.start,
            day: Some(clock.day_at(s.start)),
            kind: "session_start".into(),
            title: "Session started".into(),
            detail: String::new(),
            pos: s.login_pos,
            dim: None,
            source: "log".into(),
        });
        for e in &s.events {
            let mut e = e.clone();
            e.day = Some(clock.day_at(e.t));
            out.push(e);
        }
        let mins = (s.end - s.start) / 60000;
        out.push(Event {
            t: s.end,
            day: Some(clock.day_at(s.end)),
            kind: "session_end".into(),
            title: "Session ended".into(),
            detail: format!("{} h {:02} min", mins / 60, mins % 60),
            pos: None,
            dim: None,
            source: "log".into(),
        });
    }
    out
}

pub fn calendar(sessions: &[Session]) -> Vec<(i64, i64)> {
    // (local midnight-ish day bucket in ms, minutes played)
    let mut m: HashMap<i64, i64> = HashMap::new();
    for s in sessions {
        let day = s.start.div_euclid(86_400_000) * 86_400_000;
        *m.entry(day).or_default() += (s.end - s.start) / 60000;
    }
    let mut v: Vec<(i64, i64)> = m.into_iter().collect();
    v.sort();
    v
}
