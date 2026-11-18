//! The Lore Book: chapters written by a world historian from the journal, plus named places.

use crate::events::Event;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ChapterSection {
    pub heading: String,
    pub body: String,
    /// id of a place to illustrate this section with (optional)
    #[serde(default)]
    pub plate: Option<String>,
    /// "render" or "drawn"
    #[serde(default)]
    pub plate_style: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct PlaceSuggestion {
    pub place_id: String,
    pub name: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Chapter {
    pub number: u32,
    pub title: String,
    pub day_from: u32,
    pub day_to: u32,
    pub written_at: i64,
    #[serde(default)]
    pub model: String,
    /// Written before the chapter's last day was reached.
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub epigraph: String,
    pub sections: Vec<ChapterSection>,
    #[serde(default)]
    pub suggestions: Vec<PlaceSuggestion>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub in_memoriam: Vec<String>,
    #[serde(default)]
    pub words: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Place {
    pub id: String,
    /// Approved name (empty until the player approves one)
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub suggested: Option<String>,
    #[serde(default)]
    pub suggested_reason: String,
    pub kind: String,
    pub dim: String,
    pub center: [i32; 3],
    /// chunk-space bounding box minx, minz, maxx, maxz
    #[serde(default)]
    pub chunks: [i32; 4],
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub first_day: Option<f64>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub notes: String,
}

impl Place {
    pub fn display(&self) -> String {
        if !self.name.is_empty() {
            self.name.clone()
        } else {
            format!("Unnamed {}", self.kind)
        }
    }
}

pub fn lore_dir(world_dir: &Path) -> PathBuf {
    let d = world_dir.join("lore");
    let _ = std::fs::create_dir_all(d.join("plates"));
    d
}

pub fn load_chapters(world_dir: &Path) -> Vec<Chapter> {
    let dir = lore_dir(world_dir);
    let mut out: Vec<Chapter> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("chapter-"))
                .filter_map(|e| std::fs::read(e.path()).ok())
                .filter_map(|b| serde_json::from_slice(&b).ok())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|c: &Chapter| c.number);
    out
}

pub fn save_chapter(world_dir: &Path, c: &Chapter) -> Result<()> {
    let p = lore_dir(world_dir).join(format!("chapter-{:03}.json", c.number));
    std::fs::write(p, serde_json::to_vec_pretty(c)?)?;
    Ok(())
}

pub fn load_places(world_dir: &Path) -> Vec<Place> {
    std::fs::read(world_dir.join("places.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_places(world_dir: &Path, places: &[Place]) -> Result<()> {
    std::fs::write(world_dir.join("places.json"), serde_json::to_vec_pretty(places)?)?;
    Ok(())
}

/// Everything the historian gets to work with.
#[derive(Clone, Debug, Serialize, Default)]
pub struct ChapterInput {
    pub world_name: String,
    pub player: String,
    pub difficulty: String,
    pub hardcore: bool,
    pub number: u32,
    pub day_from: u32,
    pub day_to: u32,
    pub current_day: u32,
    pub draft: bool,
    pub events: Vec<Event>,
    pub stats: Value,
    pub places: Vec<Place>,
    pub previous: Vec<(u32, String, String)>,
    pub sessions: usize,
    pub hours_played: f64,
}

pub const SYSTEM: &str = "You are the Royal Historian of a Minecraft world, writing a documentary-style chronicle in the voice of a calm, \
observant narrator (think of a nature or history documentary). You write only from the records you are given: the journal of events, \
statistics and named places. You may add atmosphere, weather, mood and careful interpretation, but you never invent major events, \
structures, discoveries, battles or deaths that are not in the records. You never mention places, structures, biomes or resources \
that the records do not show the player has already found (no spoilers, no hints about where things are). You refer to the player \
by name. Real-world dates and times are never mentioned; time is measured in in-game days. Coordinates are used sparingly. \
Write vivid, specific, grounded prose with varied sentence rhythm. Avoid cliches like 'little did they know', 'a testament to', \
'tapestry', 'delve'. Reply with JSON only.";

fn fmt_event(e: &Event) -> String {
    let day = e.day.map(|d| format!("day {:.0}", d.floor() + 1.0)).unwrap_or_else(|| "day ?".into());
    let pos = e.pos.map(|p| format!(" at ({:.0}, {:.0}, {:.0})", p[0], p[1], p[2])).unwrap_or_default();
    let dim = e.dim.as_deref().map(|d| format!(" in {}", d.trim_start_matches("minecraft:").replace('_', " "))).unwrap_or_default();
    match e.kind.as_str() {
        "advancement" => format!("{day}: earned the advancement \"{}\"{}", e.title, if e.detail.is_empty() || e.detail == "advancement" { String::new() } else { format!(" ({})", e.detail) }),
        "death" => format!("{day}: DEATH — {}{pos}{dim}", e.title),
        "villager_death" => format!("{day}: a villager ({}) died — {}{pos}", e.detail, e.title),
        "respawn_set" => format!("{day}: set a respawn point (slept in a bed){pos}"),
        "session_start" => format!("{day}: began a play session{pos}"),
        "session_end" => format!("{day}: ended a play session ({})", e.detail),
        "chat" => format!("{day}: said in chat: \"{}\"", e.title),
        _ => format!("{day}: {} — {}{}{pos}{dim}", e.kind.replace('_', " "), e.title, if e.detail.is_empty() { String::new() } else { format!(" ({})", e.detail) }),
    }
}

pub fn build_prompt(input: &ChapterInput) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "WORLD: \"{}\" — difficulty {}, {}.\nPLAYER: {}\nTODAY: day {} of the world.\nCHAPTER {} covers days {} to {}{}.\nPlay sessions in this period: {} (about {:.1} hours at the keyboard).\n\n",
        input.world_name,
        input.difficulty,
        if input.hardcore { "HARDCORE (one life)" } else { "survival" },
        input.player,
        input.current_day,
        input.number,
        input.day_from,
        input.day_to,
        if input.draft { " — the period is still in progress, so this is a draft that ends on the present day" } else { "" },
        input.sessions,
        input.hours_played
    ));
    if !input.previous.is_empty() {
        s.push_str("EARLIER CHAPTERS (for continuity):\n");
        for (n, t, sum) in &input.previous {
            s.push_str(&format!("- Chapter {n}, \"{t}\": {sum}\n"));
        }
        s.push('\n');
    }
    s.push_str("JOURNAL OF RECORDED EVENTS (chronological):\n");
    let mut n = 0;
    for e in &input.events {
        if e.kind == "chat" && n > 400 {
            continue;
        }
        s.push_str("- ");
        s.push_str(&fmt_event(e));
        s.push('\n');
        n += 1;
    }
    if input.events.is_empty() {
        s.push_str("- (no individual events were recorded; rely on the statistics)\n");
    }
    s.push_str("\nPLACES ON RECORD (only these may be described as known places):\n");
    for p in &input.places {
        if p.hidden {
            continue;
        }
        s.push_str(&format!(
            "- id \"{}\": {} — a {} in the {} around ({}, {}, {}){}{}\n",
            p.id,
            if p.name.is_empty() { "UNNAMED".to_string() } else { format!("\"{}\"", p.name) },
            p.kind,
            p.dim.trim_start_matches("minecraft:").replace('_', " "),
            p.center[0],
            p.center[1],
            p.center[2],
            p.first_day.map(|d| format!(", first settled around day {:.0}", d + 1.0)).unwrap_or_default(),
            if p.notes.is_empty() { String::new() } else { format!(". Notes: {}", p.notes) }
        ));
    }
    s.push_str("\nLIFETIME STATISTICS (totals so far, from the game's own counters):\n");
    s.push_str(&serde_json::to_string_pretty(&input.stats).unwrap_or_default());
    s.push_str(
        "\n\nWRITE CHAPTER now as JSON with this exact shape:\n\
{\n  \"title\": \"evocative chapter title (no 'Chapter N' prefix)\",\n  \"epigraph\": \"one short line, like an inscription\",\n  \
\"sections\": [ { \"heading\": \"section heading\", \"body\": \"several paragraphs separated by blank lines\", \"plate\": \"place id to illustrate or null\", \"plate_style\": \"render or drawn\" } ],\n  \
\"place_names\": [ { \"place_id\": \"id of an UNNAMED place\", \"name\": \"a fitting proper name\", \"reason\": \"one sentence why\" } ],\n  \
\"in_memoriam\": [ \"one line per death in this period, player or villager, written like a memorial entry\" ],\n  \
\"summary\": \"two sentences summarizing the chapter for later chapters\"\n}\n\
Requirements: 6 to 9 sections; total length at least 2800 words (a 10+ minute read); every recorded player death must be documented with care; \
open with the setting and the state of the world at the start of the period, and close looking ahead without predicting specific discoveries. \
Use the unnamed places' ids in place_names (suggest names for all of them). Use plates for 2 to 4 sections that are about a known place.",
    );
    s
}

fn strip_fences(t: &str) -> &str {
    let t = t.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

/// Parse the model's reply into a chapter (lenient: falls back to plain text as one section).
pub fn parse_reply(input: &ChapterInput, text: &str, model: &str) -> Chapter {
    let body = strip_fences(text);
    let v: Value = serde_json::from_str(body)
        .or_else(|_| {
            let a = body.find('{').unwrap_or(0);
            let b = body.rfind('}').map(|b| b + 1).unwrap_or(body.len());
            serde_json::from_str(&body[a..b])
        })
        .unwrap_or(Value::Null);
    let mut c = Chapter {
        number: input.number,
        day_from: input.day_from,
        day_to: input.day_to,
        written_at: crate::now_ms(),
        model: model.to_string(),
        draft: input.draft,
        ..Default::default()
    };
    if v.is_object() {
        c.title = v.get("title").and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
        c.epigraph = v.get("epigraph").and_then(|t| t.as_str()).unwrap_or("").to_string();
        c.summary = v.get("summary").and_then(|t| t.as_str()).unwrap_or("").to_string();
        c.sections = v
            .get("sections")
            .and_then(|s| s.as_array())
            .map(|a| {
                a.iter()
                    .map(|s| ChapterSection {
                        heading: s.get("heading").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                        body: s.get("body").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                        plate: s.get("plate").and_then(|t| t.as_str()).filter(|p| !p.is_empty() && *p != "null").map(|p| p.to_string()),
                        plate_style: s.get("plate_style").and_then(|t| t.as_str()).map(|p| p.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        c.suggestions = v
            .get("place_names")
            .and_then(|s| s.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| {
                        Some(PlaceSuggestion {
                            place_id: s.get("place_id")?.as_str()?.to_string(),
                            name: s.get("name")?.as_str()?.to_string(),
                            reason: s.get("reason").and_then(|r| r.as_str()).unwrap_or("").to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        c.in_memoriam = v.get("in_memoriam").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    } else {
        c.title = "The Record".into();
        c.sections = vec![ChapterSection { heading: String::new(), body: text.to_string(), plate: None, plate_style: None }];
    }
    c.words = c.sections.iter().map(|s| s.body.split_whitespace().count()).sum();
    c
}

/// Write a chapter with the AI. Blocking (network).
pub fn write_chapter(input: &ChapterInput) -> Result<Chapter> {
    let prompt = build_prompt(input);
    let (text, model) = crate::ai::generate(SYSTEM, &prompt, 16000, 0.9)?;
    let c = parse_reply(input, &text, &model);
    if c.words < 300 {
        anyhow::bail!("the historian's reply was too short ({} words)", c.words);
    }
    Ok(c)
}
