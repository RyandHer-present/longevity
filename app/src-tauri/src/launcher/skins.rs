//! Skin closet: saved skins (your accounts', friends' by name, files you drop in) with outfits.

use super::prism;
use super::util::*;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Skin {
    pub id: String,
    pub name: String,
    pub model: String,
    pub source: String,
    pub added: i64,
    pub cape: bool,
    #[serde(default)]
    pub favorite: bool,
}

/// One skin someone wore, and when it was seen on them ("account:Name" or "player:Name").
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Seen {
    pub who: String,
    pub id: String,
    pub first: i64,
    pub last: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    skins: Vec<Skin>,
    #[serde(default)]
    history: Vec<Seen>,
}

/// Remember that `who` was wearing skin `id` just now.
fn note_seen(who: &str, id: &str) {
    let mut idx = load();
    let now = now_ms();
    if let Some(h) = idx.history.iter_mut().find(|h| h.who == who && h.id == id) {
        h.last = now;
    } else {
        idx.history.push(Seen { who: who.to_string(), id: id.to_string(), first: now, last: now });
    }
    let _ = store(&idx);
}

pub fn history() -> Vec<Seen> {
    let mut h = load().history;
    h.sort_by_key(|x| -x.first);
    h
}

/// Check every friend in the closet for a new skin (adds it, and notes it in their history).
pub fn refresh_friends() -> Vec<String> {
    let mut names: Vec<String> = load().skins.iter().filter_map(|s| s.source.strip_prefix("player:").map(|n| n.to_string())).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by_key(|n| n.to_lowercase());
    let mut changed = vec![];
    for n in names {
        let before: Vec<String> = load().skins.iter().map(|s| s.id.clone()).collect();
        if let Ok(s) = add_player(&n) {
            if !before.contains(&s.id) {
                changed.push(n.clone());
            }
        }
    }
    changed
}

/// Save a skin made in the editor.
pub fn save_png(name: &str, model: &str, png: &[u8]) -> anyhow::Result<Skin> {
    let name = if name.trim().is_empty() { "My skin" } else { name.trim() };
    add(name, png, Some(if model == "slim" { "slim".into() } else { "classic".into() }), "edited", None)
}

fn dir() -> PathBuf {
    let d = data_dir().join("skins");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn file(id: &str) -> Option<PathBuf> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(dir().join(format!("{id}.png")))
}

pub fn cape_file(id: &str) -> Option<PathBuf> {
    file(id).map(|p| p.with_file_name(format!("{id}.cape.png")))
}

fn load() -> Index {
    read_json(&dir().join("closet.json"))
}

fn store(i: &Index) -> anyhow::Result<()> {
    write_json(&dir().join("closet.json"), i)
}

pub fn list() -> Vec<Skin> {
    let mut l = load().skins;
    l.retain(|s| file(&s.id).map(|p| p.is_file()).unwrap_or(false));
    l
}

/// Slim (Alex) arms leave this column of the right arm empty.
fn detect_model(png: &[u8]) -> String {
    if let Ok(img) = image::load_from_memory(png) {
        let img = img.to_rgba8();
        if img.height() >= 64 {
            let px = img.get_pixel(54, 20);
            if px[3] == 0 {
                return "slim".into();
            }
        }
    }
    "classic".into()
}

fn add(name: &str, png: &[u8], model: Option<String>, source: &str, cape: Option<Vec<u8>>) -> anyhow::Result<Skin> {
    let img = image::load_from_memory(png)?;
    if img.width() != 64 || !(img.height() == 64 || img.height() == 32) {
        anyhow::bail!("a skin must be a 64x64 (or old 64x32) PNG");
    }
    let mut idx = load();
    let hash = sha1_hex(png);
    if let Some(s) = idx.skins.iter().find(|s| s.id == hash[..16]) {
        return Ok(s.clone());
    }
    let id = hash[..16].to_string();
    std::fs::write(file(&id).unwrap(), png)?;
    let has_cape = if let Some(c) = cape {
        std::fs::write(cape_file(&id).unwrap(), c)?;
        true
    } else {
        false
    };
    let s = Skin { id, name: name.to_string(), model: model.unwrap_or_else(|| detect_model(png)), source: source.to_string(), added: now_ms(), cape: has_cape, favorite: false };
    idx.skins.insert(0, s.clone());
    store(&idx)?;
    Ok(s)
}

fn textures_of(uuid: &str) -> anyhow::Result<(Option<String>, Option<String>, Option<String>)> {
    let p = get_json(&format!("https://sessionserver.mojang.com/session/minecraft/profile/{}", uuid.replace('-', "")))?;
    let props = p.get("properties").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    for pr in props {
        if pr.get("name").and_then(|n| n.as_str()) == Some("textures") {
            let raw = pr.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let dec = base64::engine::general_purpose::STANDARD.decode(raw)?;
            let v: Value = serde_json::from_slice(&dec)?;
            let t = v.get("textures").cloned().unwrap_or(Value::Null);
            let skin = t.get("SKIN").and_then(|s| s.get("url")).and_then(|u| u.as_str()).map(|s| s.to_string());
            let model = t.get("SKIN").and_then(|s| s.get("metadata")).and_then(|m| m.get("model")).and_then(|m| m.as_str()).map(|m| if m == "slim" { "slim".to_string() } else { "classic".to_string() });
            let cape = t.get("CAPE").and_then(|s| s.get("url")).and_then(|u| u.as_str()).map(|s| s.to_string());
            return Ok((skin, model, cape));
        }
    }
    Ok((None, None, None))
}

fn https(u: &str) -> String {
    u.replacen("http://", "https://", 1)
}

/// Add a player's current skin (and cape) by their Minecraft name.
pub fn add_player(name: &str) -> anyhow::Result<Skin> {
    let name = name.trim();
    if name.is_empty() || name.len() > 16 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        anyhow::bail!("that isn't a valid Minecraft name");
    }
    let p = get_json(&format!("https://api.mojang.com/users/profiles/minecraft/{name}")).map_err(|_| anyhow::anyhow!("no player called {name}"))?;
    let uuid = p.get("id").and_then(|i| i.as_str()).ok_or_else(|| anyhow::anyhow!("no player called {name}"))?.to_string();
    let real = p.get("name").and_then(|i| i.as_str()).unwrap_or(name).to_string();
    let (skin, model, cape) = textures_of(&uuid)?;
    let skin = skin.ok_or_else(|| anyhow::anyhow!("{real} uses a default skin"))?;
    let png = get_bytes(&https(&skin))?;
    let cape = cape.and_then(|c| get_bytes(&https(&c)).ok());
    let s = add(&real, &png, model, &format!("player:{real}"), cape)?;
    note_seen(&format!("player:{real}"), &s.id);
    Ok(s)
}

/// Pull in the skins your Prism accounts wear right now.
pub fn sync_accounts() -> Vec<Skin> {
    let mut out = vec![];
    for p in prism::profiles() {
        let r = (|| -> anyhow::Result<Skin> {
            let (skin, model, cape) = textures_of(&p.id)?;
            let url = skin.or(p.skin_url.clone()).ok_or_else(|| anyhow::anyhow!("default skin"))?;
            let png = get_bytes(&https(&url))?;
            let cape = cape.and_then(|c| get_bytes(&https(&c)).ok());
            let model = model.or_else(|| p.skin_variant.as_ref().map(|v| if v.eq_ignore_ascii_case("slim") { "slim".into() } else { "classic".into() }));
            let s = add(&p.name, &png, model, &format!("account:{}", p.name), cape)?;
            note_seen(&format!("account:{}", p.name), &s.id);
            Ok(s)
        })();
        if let Ok(s) = r {
            out.push(s);
        }
    }
    out
}

pub fn import_file(path: &str) -> anyhow::Result<Skin> {
    let p = PathBuf::from(path);
    let png = std::fs::read(&p)?;
    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Skin".into());
    add(&name, &png, None, "file", None)
}

pub fn update(id: &str, name: Option<String>, model: Option<String>, favorite: Option<bool>) -> anyhow::Result<Vec<Skin>> {
    let mut idx = load();
    if let Some(s) = idx.skins.iter_mut().find(|s| s.id == id) {
        if let Some(n) = name {
            s.name = n.chars().take(40).collect();
        }
        if let Some(m) = model.filter(|m| m == "slim" || m == "classic") {
            s.model = m;
        }
        if let Some(f) = favorite {
            s.favorite = f;
        }
    }
    store(&idx)?;
    Ok(list())
}

pub fn delete(id: &str) -> anyhow::Result<Vec<Skin>> {
    let mut idx = load();
    idx.skins.retain(|s| s.id != id);
    store(&idx)?;
    if let Some(f) = file(id) {
        let _ = std::fs::remove_file(f);
    }
    if let Some(f) = cape_file(id) {
        let _ = std::fs::remove_file(f);
    }
    Ok(list())
}

/// "Wear" hands off to the official skin page with the file ready, since Prism holds the login.
pub fn export_for_wear(id: &str) -> anyhow::Result<PathBuf> {
    let src = file(id).ok_or_else(|| anyhow::anyhow!("bad skin"))?;
    let s = list().into_iter().find(|s| s.id == id).ok_or_else(|| anyhow::anyhow!("skin not found"))?;
    let out_dir = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| data_dir()).join("Downloads");
    let clean: String = s.name.chars().map(|c| if c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-' { c } else { '_' }).collect();
    let dst = out_dir.join(format!("{} skin ({}).png", clean.trim(), s.model));
    std::fs::copy(src, &dst)?;
    Ok(dst)
}
