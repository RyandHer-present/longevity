//! Settings sync between two instances (LongTerm 26.3 <-> astera 1.21.11 by default):
//! keybinds + controls, video, sound, chat, resource packs and shared mod configs.
//!
//! Safety rules:
//! - Only settings that exist under the same name in BOTH options.txt files are offered,
//!   so a setting that was renamed or removed between versions is never written blindly.
//! - A resource pack is checked against the other version's pack format (read from its client jar).
//! - Nothing is written while either game is running (Minecraft rewrites options.txt on exit).
//! - Every write is backed up first; "Undo" puts the files back.
use super::prism;
use super::util::{data_dir, now_ms, read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

const VIDEO: &[&str] = &[
    "ao", "biomeBlendRadius", "chunkSectionFadeInTime", "cutoutLeaves", "enableVsync", "entityDistanceScaling", "entityShadows", "fov",
    "fovEffectScale", "darknessEffectScale", "glintSpeed", "glintStrength", "graphicsPreset", "graphicsMode", "prioritizeChunkUpdates",
    "fullscreen", "guiScale", "maxAnisotropyBit", "textureFiltering", "maxFps", "improvedTransparency", "inactivityFpsLimit", "mipmapLevels",
    "particles", "renderClouds", "cloudRange", "renderDistance", "simulationDistance", "screenEffectScale", "vignette", "weatherRadius",
    "bobView", "menuBackgroundBlurriness", "gamma", "damageTiltStrength", "hideLightningFlashes", "attackIndicator",
];
const CONTROLS: &[&str] = &[
    "mouseSensitivity", "invertXMouse", "invertYMouse", "autoJump", "toggleCrouch", "toggleSprint", "toggleAttack", "toggleUse",
    "sprintWindow", "discrete_mouse_scroll", "mouseWheelSensitivity", "mainHand", "rawMouseInput", "rotateWithMinecart",
];
const SOUND: &[&str] = &["showSubtitles", "directionalAudio", "musicFrequency", "musicToast"];
const CHAT: &[&str] = &[
    "chatVisibility", "chatColors", "chatLinks", "chatLinksPrompt", "chatOpacity", "chatLineSpacing", "textBackgroundOpacity",
    "backgroundForChatOnly", "chatHeightFocused", "chatHeightUnfocused", "chatScale", "chatWidth", "chatDelay", "hideMatchedNames",
    "notificationDisplayTime", "advancedItemTooltips", "autoSuggestions", "saveChatDrafts", "highContrast", "highContrastBlockOutline",
    "showAutosaveIndicator", "pauseOnLostFocus", "lang", "forceUnicodeFont",
];
const CATS: &[&str] = &["controls", "video", "sound", "chat"];

fn cat_of(k: &str) -> Option<&'static str> {
    if k.starts_with("key_") || CONTROLS.contains(&k) {
        Some("controls")
    } else if VIDEO.contains(&k) {
        Some("video")
    } else if k.starts_with("soundCategory_") || SOUND.contains(&k) {
        Some("sound")
    } else if CHAT.contains(&k) || k.starts_with("modelPart_") {
        Some("chat")
    } else {
        None
    }
}

// ---------------------------------------------------------------- options.txt

/// options.txt as ordered (key, value) lines; lines without a colon are kept as-is.
fn read_options(mc: &Path) -> Vec<(String, Option<String>)> {
    std::fs::read_to_string(mc.join("options.txt"))
        .unwrap_or_default()
        .lines()
        .map(|l| match l.split_once(':') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (l.to_string(), None),
        })
        .collect()
}
fn opt_map(lines: &[(String, Option<String>)]) -> HashMap<String, String> {
    lines.iter().filter_map(|(k, v)| v.as_ref().map(|v| (k.clone(), v.clone()))).collect()
}
/// Replace the given keys in options.txt (only keys that are already there).
/// Returns how many settings changed (the two pack-list lines are not counted).
fn write_options(mc: &Path, set: &HashMap<String, String>) -> anyhow::Result<usize> {
    let mut lines = read_options(mc);
    let mut n = 0;
    for (k, v) in lines.iter_mut() {
        if let (Some(cur), Some(new)) = (v.as_mut(), set.get(k.as_str())) {
            if cur != new {
                *cur = new.clone();
                if k != "resourcePacks" && k != "incompatibleResourcePacks" {
                    n += 1;
                }
            }
        }
    }
    let mut s: String = lines.iter().map(|(k, v)| match v { Some(v) => format!("{k}:{v}\n"), None => format!("{k}\n") }).collect();
    if s.is_empty() {
        s.push('\n');
    }
    std::fs::write(mc.join("options.txt"), s)?;
    Ok(n)
}

/// A readable name for an option ("key_key.sprint" -> "Sprint", "renderDistance" -> "Render distance").
fn label(k: &str) -> String {
    let raw = if let Some(r) = k.strip_prefix("key_") {
        let r = r.trim_start_matches("key.");
        r.rsplit('.').next().unwrap_or(r).to_string()
    } else if let Some(r) = k.strip_prefix("soundCategory_") {
        format!("{r} volume")
    } else if let Some(r) = k.strip_prefix("modelPart_") {
        format!("show {r}")
    } else {
        k.to_string()
    };
    // camelCase / snake_case -> words
    let mut out = String::new();
    let mut prev_lower = false;
    for ch in raw.chars() {
        if ch == '_' || ch == '-' {
            out.push(' ');
            prev_lower = false;
            continue;
        }
        if ch.is_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        out.push(ch.to_ascii_lowercase());
    }
    let mut c = out.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => out,
    }
}

/// Which mod a keybind belongs to ("key_key.punchy.toggle" -> "punchy"), None for vanilla.
fn key_mod(k: &str) -> Option<String> {
    let r = k.strip_prefix("key_")?;
    let parts: Vec<&str> = r.split('.').collect();
    if parts.len() >= 3 && parts[0] == "key" && !["hotbar", "debug", "spectator", "quickActions"].contains(&parts[1]) {
        return Some(parts[1].to_string());
    }
    if parts.len() >= 2 && parts[0] != "key" {
        return Some(parts[0].to_string());
    }
    None
}

// ---------------------------------------------------------------- resource packs

/// The resource pack format a Minecraft version uses, read from its client jar: (major, minor).
pub(crate) fn version_format(mc_version: &str) -> Option<(u32, u32)> {
    let jar = mcassets::jar::find_client_jar(mc_version)?;
    let f = std::fs::File::open(jar).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut s = String::new();
    z.by_name("version.json").ok()?.read_to_string(&mut s).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let pv = &v["pack_version"];
    if let Some(m) = pv["resource_major"].as_u64() {
        return Some((m as u32, pv["resource_minor"].as_u64().unwrap_or(0) as u32));
    }
    pv["resource"].as_u64().or_else(|| pv.as_u64()).map(|m| (m as u32, 0))
}

fn fmt_of(v: &Value) -> Option<(u32, u32)> {
    if let Some(a) = v.as_array() {
        return Some((a.first()?.as_u64()? as u32, a.get(1).and_then(|x| x.as_u64()).unwrap_or(0) as u32));
    }
    if let Some(i) = v.as_u64() {
        return Some((i as u32, 0));
    }
    if let Some(f) = v.as_f64() {
        // 97.1 -> (97, 1)
        let s = format!("{f}");
        let (a, b) = s.split_once('.').unwrap_or((&s, "0"));
        return Some((a.parse().ok()?, b.parse().unwrap_or(0)));
    }
    None
}

/// The range of formats a pack says it supports.
pub(crate) fn pack_range(meta: &Value) -> Option<((u32, u32), (u32, u32))> {
    let p = &meta["pack"];
    if let (Some(a), Some(b)) = (fmt_of(&p["min_format"]), fmt_of(&p["max_format"])) {
        return Some((a, b));
    }
    let sf = &p["supported_formats"];
    if let Some(a) = sf.as_array() {
        if let (Some(x), Some(y)) = (a.first().and_then(fmt_of), a.get(1).and_then(fmt_of)) {
            return Some((x, (y.0, u32::MAX)));
        }
    }
    if let (Some(x), Some(y)) = (fmt_of(&sf["min_inclusive"]), fmt_of(&sf["max_inclusive"])) {
        return Some((x, y));
    }
    if let Some(x) = fmt_of(sf) {
        return Some(((x.0, 0), (x.0, u32::MAX)));
    }
    let f = fmt_of(&p["pack_format"])?;
    Some(((f.0, 0), (f.0, u32::MAX)))
}

fn pack_meta(path: &Path) -> Option<Value> {
    if path.is_dir() {
        return serde_json::from_str(&std::fs::read_to_string(path.join("pack.mcmeta")).ok()?).ok();
    }
    let f = std::fs::File::open(path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut s = String::new();
    z.by_name("pack.mcmeta").ok()?.read_to_string(&mut s).ok()?;
    // some packs start with a BOM
    serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()
}

fn parse_list(v: Option<&String>) -> Vec<String> {
    v.and_then(|s| serde_json::from_str::<Vec<String>>(s).ok()).unwrap_or_default()
}

#[derive(Serialize, Clone)]
struct PackRow {
    id: String,
    name: String,
    /// "builtin" | "file" | "mod"
    kind: String,
    on_a: bool,
    on_b: bool,
    file_a: bool,
    file_b: bool,
    /// works with each side's version (None: unknown)
    ok_a: Option<bool>,
    ok_b: Option<bool>,
}

pub(crate) fn compat(range: Option<((u32, u32), (u32, u32))>, target: Option<(u32, u32)>) -> Option<bool> {
    let ((lo, hi), t) = (range?, target?);
    Some(lo <= t && t <= hi)
}

// ---------------------------------------------------------------- configs

const CONFIG_EXT: &[&str] = &["json", "json5", "toml", "properties", "txt", "yml", "yaml", "cfg", "conf", "ini", "snbt"];

fn config_files(mc: &Path) -> BTreeMap<String, (u64, i64)> {
    let mut out = BTreeMap::new();
    let root = mc.join("config");
    fn walk(root: &Path, d: &Path, depth: u32, out: &mut BTreeMap<String, (u64, i64)>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 3 {
                    walk(root, &p, depth + 1, out);
                }
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !CONFIG_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if m.len() > 512 * 1024 {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.insert(rel, (m.len(), t));
        }
    }
    walk(&root, &root, 0, &mut out);
    out
}

fn safe_rel(rel: &str) -> bool {
    !rel.is_empty() && !rel.contains("..") && !rel.starts_with('/') && !rel.contains(':')
}

// ---------------------------------------------------------------- state (auto sync + snapshots)

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct SyncState {
    pub a: String,
    pub b: String,
    /// keep the chosen categories in step after every session
    pub auto: bool,
    pub cats: Vec<String>,
    pub packs: bool,
    /// options.txt of an instance when its game started (for "what changed this session")
    #[serde(default)]
    pub before: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub last: i64,
}

fn state_path() -> PathBuf {
    data_dir().join("sync.json")
}
pub fn state() -> SyncState {
    let mut s: SyncState = read_json(&state_path());
    if s.a.is_empty() || s.b.is_empty() {
        // default pair: LongTerm <-> astera when both exist
        let ids: Vec<String> = prism::instances().into_iter().map(|i| i.id).collect();
        let find = |n: &str| ids.iter().find(|i| i.eq_ignore_ascii_case(n)).cloned();
        s.a = find("LongTerm").unwrap_or_default();
        s.b = find("astera").unwrap_or_default();
        if s.cats.is_empty() {
            s.cats = vec!["controls".into(), "video".into()];
        }
    }
    s
}
fn save_state(s: &SyncState) {
    let _ = write_json(&state_path(), s);
}

fn mc_of(id: &str) -> anyhow::Result<(prism::Instance, PathBuf)> {
    let i = prism::instance(id).ok_or_else(|| anyhow::anyhow!("instance {id} not found"))?;
    let mc = PathBuf::from(&i.mc_dir);
    Ok((i, mc))
}

// ---------------------------------------------------------------- compare

/// Everything that differs between the two instances, grouped for the page.
pub fn compare(a: &str, b: &str) -> anyhow::Result<Value> {
    let (ia, ma) = mc_of(a)?;
    let (ib, mb) = mc_of(b)?;
    let oa = opt_map(&read_options(&ma));
    let ob = opt_map(&read_options(&mb));

    let mut rows: Vec<Value> = vec![];
    let mut same: HashMap<&str, usize> = HashMap::new();
    let mut only_a = 0;
    let mut only_b = 0;
    let mut keys: Vec<&String> = oa.keys().collect();
    keys.sort();
    for k in keys {
        let Some(cat) = cat_of(k) else { continue };
        let Some(vb) = ob.get(k) else {
            only_a += 1;
            continue;
        };
        let va = &oa[k];
        if va == vb {
            *same.entry(cat).or_default() += 1;
            continue;
        }
        rows.push(json!({ "key": k, "label": label(k), "cat": cat, "a": va, "b": vb, "mod": key_mod(k) }));
    }
    for k in ob.keys() {
        if cat_of(k).is_some() && !oa.contains_key(k) {
            only_b += 1;
        }
    }

    // resource packs
    let fa = version_format(&ia.mc_version);
    let fb = version_format(&ib.mc_version);
    let la = parse_list(oa.get("resourcePacks"));
    let lb = parse_list(ob.get("resourcePacks"));
    let mut ids: Vec<String> = vec![];
    for id in la.iter().chain(lb.iter()) {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    // packs sitting in either folder but not enabled are offered too
    for mc in [&ma, &mb] {
        if let Ok(rd) = std::fs::read_dir(mc.join("resourcepacks")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                let id = format!("file/{n}");
                if (n.ends_with(".zip") || e.path().is_dir()) && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    let mut packs = vec![];
    for id in ids {
        let (kind, name) = if let Some(f) = id.strip_prefix("file/") {
            ("file", f.trim_end_matches(".zip").to_string())
        } else if id.contains(':') {
            ("mod", id.split(':').nth(1).unwrap_or(&id).replace('_', " "))
        } else {
            ("builtin", id.replace('_', " "))
        };
        let pa = id.strip_prefix("file/").map(|f| ma.join("resourcepacks").join(f));
        let pb = id.strip_prefix("file/").map(|f| mb.join("resourcepacks").join(f));
        let file_a = pa.as_ref().map(|p| p.exists()).unwrap_or(false);
        let file_b = pb.as_ref().map(|p| p.exists()).unwrap_or(false);
        let range = pa.as_ref().filter(|p| p.exists()).or(pb.as_ref().filter(|p| p.exists())).and_then(|p| pack_meta(p)).and_then(|m| pack_range(&m));
        let builtin = kind == "builtin";
        packs.push(PackRow {
            name,
            kind: kind.into(),
            on_a: la.contains(&id),
            on_b: lb.contains(&id),
            file_a,
            file_b,
            ok_a: if builtin { Some(true) } else { compat(range, fa) },
            ok_b: if builtin { Some(true) } else { compat(range, fb) },
            id,
        });
    }

    // shared mod configs that differ
    let ca = config_files(&ma);
    let cb = config_files(&mb);
    let mut configs = vec![];
    for (rel, (sa, ta)) in &ca {
        let Some((sb, tb)) = cb.get(rel) else { continue };
        let da = std::fs::read(ma.join("config").join(rel)).unwrap_or_default();
        let db = std::fs::read(mb.join("config").join(rel)).unwrap_or_default();
        if da == db {
            continue;
        }
        configs.push(json!({ "path": rel, "size_a": sa, "size_b": sb, "time_a": ta, "time_b": tb }));
    }

    let running = prism::running();
    Ok(json!({
        "a": { "id": ia.id, "name": ia.name, "version": ia.mc_version, "format": fa.map(|f| format!("{}.{}", f.0, f.1)), "running": running.contains_key(&ia.id) },
        "b": { "id": ib.id, "name": ib.name, "version": ib.mc_version, "format": fb.map(|f| format!("{}.{}", f.0, f.1)), "running": running.contains_key(&ib.id) },
        "rows": rows,
        "same": same,
        "only_a": only_a,
        "only_b": only_b,
        "packs": packs,
        "configs": configs,
        "packs_a": la,
        "packs_b": lb,
        "shared_configs": ca.keys().filter(|k| cb.contains_key(*k)).count(),
    }))
}

// ---------------------------------------------------------------- apply

#[derive(Deserialize, Default)]
pub struct Plan {
    /// option keys whose value goes a -> b, and b -> a
    #[serde(default)]
    pub to_b: Vec<String>,
    #[serde(default)]
    pub to_a: Vec<String>,
    /// make the target's enabled packs match the source's: "a_to_b" | "b_to_a" | ""
    #[serde(default)]
    pub packs_dir: String,
    /// which of the source's packs to bring along (ids)
    #[serde(default)]
    pub packs: Vec<String>,
    /// config files to copy, with their direction
    #[serde(default)]
    pub configs_to_b: Vec<String>,
    #[serde(default)]
    pub configs_to_a: Vec<String>,
}

fn backup_dir(label: &str) -> PathBuf {
    data_dir().join("sync-backups").join(format!("{}_{label}", now_ms()))
}

/// Save copies of the files we are about to change. `files` are (instance id, path relative to its mc dir).
fn backup(label: &str, files: &[(String, String)]) -> anyhow::Result<PathBuf> {
    let dir = backup_dir(label);
    let mut index = vec![];
    for (inst, rel) in files {
        let (_, mc) = mc_of(inst)?;
        let src = mc.join(rel);
        let dst = dir.join(inst).join(rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        let existed = src.is_file();
        if existed {
            std::fs::copy(&src, &dst)?;
        }
        index.push(json!({ "inst": inst, "rel": rel, "existed": existed }));
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("backup.json"), serde_json::to_vec_pretty(&json!({ "t": now_ms(), "label": label, "files": index }))?)?;
    // keep the newest 25
    if let Ok(rd) = std::fs::read_dir(data_dir().join("sync-backups")) {
        let mut all: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        all.sort();
        while all.len() > 25 {
            let _ = std::fs::remove_dir_all(all.remove(0));
        }
    }
    Ok(dir)
}

fn copy_pack(from_mc: &Path, to_mc: &Path, id: &str) -> anyhow::Result<bool> {
    let Some(f) = id.strip_prefix("file/") else { return Ok(false) };
    if !safe_rel(f) || f.contains('/') {
        return Ok(false);
    }
    let src = from_mc.join("resourcepacks").join(f);
    let dst = to_mc.join("resourcepacks").join(f);
    if dst.exists() || !src.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(to_mc.join("resourcepacks"))?;
    if src.is_dir() {
        super::util::copy_dir(&src, &dst)?;
    } else {
        std::fs::copy(&src, &dst)?;
    }
    Ok(true)
}

/// The target's new pack list: the source's order, keeping only packs the target can load.
fn pack_list_for(src_list: &[String], chosen: &[String], tgt_mc: &Path, tgt_old: &[String]) -> Vec<String> {
    let mut out = vec![];
    for id in src_list {
        let keep = if id.starts_with("file/") {
            chosen.contains(id) && tgt_mc.join("resourcepacks").join(id.trim_start_matches("file/")).exists()
        } else if id.contains(':') {
            // a pack a mod provides: only if the target already had it (so that mod is there)
            tgt_old.contains(id)
        } else {
            true
        };
        if keep && !out.contains(id) {
            out.push(id.clone());
        }
    }
    if !out.iter().any(|x| x == "vanilla") {
        out.insert(0, "vanilla".into());
    }
    out
}

pub fn apply(a: &str, b: &str, plan: &Plan) -> anyhow::Result<Value> {
    let running = prism::running();
    for id in [a, b] {
        if running.contains_key(id) {
            anyhow::bail!("Close Minecraft ({id}) first. It saves its settings when it closes, which would undo the sync.");
        }
    }
    let (ia, ma) = mc_of(a)?;
    let (ib, mb) = mc_of(b)?;
    let oa = opt_map(&read_options(&ma));
    let ob = opt_map(&read_options(&mb));

    // what will change
    let mut files: Vec<(String, String)> = vec![];
    let touches_a = !plan.to_a.is_empty() || plan.packs_dir == "b_to_a";
    let touches_b = !plan.to_b.is_empty() || plan.packs_dir == "a_to_b";
    if touches_a {
        files.push((a.into(), "options.txt".into()));
    }
    if touches_b {
        files.push((b.into(), "options.txt".into()));
    }
    for rel in plan.configs_to_b.iter().filter(|r| safe_rel(r)) {
        files.push((b.into(), format!("config/{rel}")));
    }
    for rel in plan.configs_to_a.iter().filter(|r| safe_rel(r)) {
        files.push((a.into(), format!("config/{rel}")));
    }
    if files.is_empty() {
        anyhow::bail!("Nothing picked to sync.");
    }
    let bdir = backup(&format!("{}-{}", ia.name, ib.name).replace(['/', '\\', ':'], "_"), &files)?;

    // options
    let pick = |keys: &[String], from: &HashMap<String, String>, to: &HashMap<String, String>| -> HashMap<String, String> {
        keys.iter().filter(|k| cat_of(k).is_some() && to.contains_key(*k)).filter_map(|k| from.get(k).map(|v| (k.clone(), v.clone()))).collect()
    };
    let mut set_a = pick(&plan.to_a, &ob, &oa);
    let mut set_b = pick(&plan.to_b, &oa, &ob);

    // packs
    let mut copied = 0;
    let mut added: Vec<(String, String)> = vec![];
    if plan.packs_dir == "a_to_b" || plan.packs_dir == "b_to_a" {
        let (src_mc, tgt_mc, src_o, tgt_o, tgt_inst, set) = if plan.packs_dir == "a_to_b" { (&ma, &mb, &oa, &ob, &ib, &mut set_b) } else { (&mb, &ma, &ob, &oa, &ia, &mut set_a) };
        let tgt_id = tgt_inst.id.clone();
        for id in &plan.packs {
            if copy_pack(src_mc, tgt_mc, id)? {
                copied += 1;
                added.push((tgt_id.clone(), format!("resourcepacks/{}", id.trim_start_matches("file/"))));
            }
        }
        let src_list = parse_list(src_o.get("resourcePacks"));
        let tgt_old = parse_list(tgt_o.get("resourcePacks"));
        let list = pack_list_for(&src_list, &plan.packs, tgt_mc, &tgt_old);
        // packs made for another version must be listed as accepted, or the game drops them
        let tf = version_format(&tgt_inst.mc_version);
        let mut incompatible = parse_list(tgt_o.get("incompatibleResourcePacks"));
        incompatible.retain(|x| list.contains(x));
        for id in &list {
            if let Some(f) = id.strip_prefix("file/") {
                let ok = compat(pack_meta(&tgt_mc.join("resourcepacks").join(f)).and_then(|m| pack_range(&m)), tf);
                if ok == Some(false) && !incompatible.contains(id) {
                    incompatible.push(id.clone());
                }
            }
        }
        set.insert("resourcePacks".into(), serde_json::to_string(&list)?);
        set.insert("incompatibleResourcePacks".into(), serde_json::to_string(&incompatible)?);
    }

    let mut changed = 0;
    if !set_a.is_empty() {
        changed += write_options(&ma, &set_a)?;
    }
    if !set_b.is_empty() {
        changed += write_options(&mb, &set_b)?;
    }

    // configs
    let mut cfgs = 0;
    for (list, from, to) in [(&plan.configs_to_b, &ma, &mb), (&plan.configs_to_a, &mb, &ma)] {
        for rel in list.iter().filter(|r| safe_rel(r)) {
            let src = from.join("config").join(rel);
            let dst = to.join("config").join(rel);
            if src.is_file() {
                if let Some(p) = dst.parent() {
                    std::fs::create_dir_all(p)?;
                }
                std::fs::copy(&src, &dst)?;
                cfgs += 1;
            }
        }
    }

    if !added.is_empty() {
        // Undo deletes the pack files this sync copied in
        let bj = bdir.join("backup.json");
        if let Ok(mut v) = serde_json::from_str::<Value>(&std::fs::read_to_string(&bj).unwrap_or_default()) {
            if let Some(a) = v["files"].as_array_mut() {
                for (inst, rel) in &added {
                    a.push(json!({ "inst": inst, "rel": rel, "existed": false }));
                }
            }
            let _ = std::fs::write(&bj, serde_json::to_vec_pretty(&v)?);
        }
    }

    let mut st = state();
    st.last = now_ms();
    save_state(&st);
    Ok(json!({ "options": changed, "packs_copied": copied, "configs": cfgs, "backup": bdir.file_name().map(|f| f.to_string_lossy().to_string()) }))
}

// ---------------------------------------------------------------- undo

pub fn backups() -> Vec<Value> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(data_dir().join("sync-backups")) {
        for e in rd.flatten() {
            if let Ok(t) = std::fs::read_to_string(e.path().join("backup.json")) {
                if let Ok(mut v) = serde_json::from_str::<Value>(&t) {
                    v["id"] = json!(e.file_name().to_string_lossy());
                    out.push(v);
                }
            }
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["t"].as_i64().unwrap_or(0)));
    out
}

pub fn restore(id: &str) -> anyhow::Result<usize> {
    if !safe_rel(id) || id.contains('/') || id.contains('\\') {
        anyhow::bail!("bad backup id");
    }
    let dir = data_dir().join("sync-backups").join(id);
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("backup.json"))?)?;
    let running = prism::running();
    let mut n = 0;
    for f in v["files"].as_array().cloned().unwrap_or_default() {
        let inst = f["inst"].as_str().unwrap_or("");
        let rel = f["rel"].as_str().unwrap_or("");
        if !prism::safe_id(inst) || !safe_rel(rel) {
            continue;
        }
        if running.contains_key(inst) {
            anyhow::bail!("Close Minecraft ({inst}) first.");
        }
        let (_, mc) = mc_of(inst)?;
        let dst = mc.join(rel);
        if f["existed"].as_bool() == Some(true) {
            std::fs::copy(dir.join(inst).join(rel), &dst)?;
        } else if dst.is_dir() {
            let _ = std::fs::remove_dir_all(&dst);
        } else {
            let _ = std::fs::remove_file(&dst);
        }
        n += 1;
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(n)
}

// ---------------------------------------------------------------- auto sync around sessions

pub fn set_state(a: String, b: String, auto: bool, cats: Vec<String>, packs: bool) {
    let mut s = state();
    s.a = a;
    s.b = b;
    s.auto = auto;
    s.cats = cats.into_iter().filter(|c| CATS.contains(&c.as_str())).collect();
    s.packs = packs;
    save_state(&s);
}

/// A game is starting: remember its settings, so afterwards we know what was changed in game.
pub fn before_game(id: &str) {
    let mut s = state();
    if !s.auto || (id != s.a && id != s.b) {
        return;
    }
    if let Ok((_, mc)) = mc_of(id) {
        s.before.insert(id.to_string(), opt_map(&read_options(&mc)));
        save_state(&s);
    }
}

/// A game closed: copy what was changed in it (in the chosen categories) to the other instance.
/// Returns a short note for a toast, or None when nothing moved.
pub fn after_game(id: &str) -> Option<String> {
    let mut s = state();
    if !s.auto || (id != s.a && id != s.b) {
        return None;
    }
    let other = if id == s.a { s.b.clone() } else { s.a.clone() };
    let before = s.before.remove(id)?;
    save_state(&s);
    if prism::running().contains_key(&other) {
        return None;
    }
    let (_, mc) = mc_of(id).ok()?;
    let (_, omc) = mc_of(&other).ok()?;
    let now = opt_map(&read_options(&mc));
    let theirs = opt_map(&read_options(&omc));
    let changed: Vec<String> = now
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .filter(|(k, _)| cat_of(k).map(|c| s.cats.iter().any(|x| x == c)).unwrap_or(false))
        .filter(|(k, v)| theirs.get(*k).map(|t| t != *v).unwrap_or(false))
        .map(|(k, _)| k.clone())
        .collect();
    let packs_changed = s.packs && now.get("resourcePacks") != before.get("resourcePacks");
    if changed.is_empty() && !packs_changed {
        return None;
    }
    let mut plan = Plan::default();
    let to_other = if id == s.a { &mut plan.to_b } else { &mut plan.to_a };
    *to_other = changed.clone();
    if packs_changed {
        plan.packs_dir = if id == s.a { "a_to_b".into() } else { "b_to_a".into() };
        // only packs that work on the other version
        let ov = prism::instance(&other).map(|i| i.mc_version).unwrap_or_default();
        let of = version_format(&ov);
        plan.packs = parse_list(now.get("resourcePacks"))
            .into_iter()
            .filter(|p| p.starts_with("file/"))
            .filter(|p| compat(pack_meta(&mc.join("resourcepacks").join(p.trim_start_matches("file/"))).and_then(|m| pack_range(&m)), of) == Some(true))
            .collect();
    }
    let (a, b) = (s.a.clone(), s.b.clone());
    let r = apply(&a, &b, &plan).ok()?;
    let n = r["options"].as_u64().unwrap_or(0);
    let on = prism::instance(&other).map(|i| i.name).unwrap_or(other);
    Some(if packs_changed && n == 0 {
        format!("Your resource packs are now the same in {on}.")
    } else {
        format!("Synced {n} setting{} you changed to {on}.", if n == 1 { "" } else { "s" })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs only with SYNC_TEST_BOX pointing at a sandbox copy of the two instances.
    #[test]
    fn auto_sync_after_a_session() {
        let Ok(sb) = std::env::var("SYNC_TEST_BOX") else { return };
        unsafe {
            std::env::set_var("MIO_PRISM_DIR", format!("{sb}/prism"));
            std::env::set_var("LONGEVITY_LAUNCHER_DIR", format!("{sb}/launcher"));
        }
        set_state("LongTerm".into(), "astera".into(), true, vec!["video".into()], false);
        before_game("LongTerm");
        // in game: render distance and a keybind change
        let (_, mc) = mc_of("LongTerm").unwrap();
        let (_, omc) = mc_of("astera").unwrap();
        let theirs_before = opt_map(&read_options(&omc));
        let mut m = HashMap::new();
        m.insert("renderDistance".to_string(), "20".to_string());
        m.insert("key_key.sprint".to_string(), "key.keyboard.r".to_string());
        write_options(&mc, &m).unwrap();
        let note = after_game("LongTerm");
        println!("note: {note:?}");
        let theirs = opt_map(&read_options(&omc));
        assert_eq!(theirs["renderDistance"], "20", "video change copied");
        assert_eq!(theirs["key_key.sprint"], theirs_before["key_key.sprint"], "controls were not picked, so left alone");
        let changed: Vec<_> = theirs.iter().filter(|(k, v)| theirs_before.get(*k) != Some(*v)).collect();
        assert_eq!(changed.len(), 1, "only one line changed: {changed:?}");
        // nothing changed the second time
        before_game("LongTerm");
        assert!(after_game("LongTerm").is_none());
        // an instance outside the pair is ignored
        before_game("Holdfast");
        assert!(after_game("Holdfast").is_none());
    }
}
