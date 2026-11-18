//! Installed mods (read straight from the jars), Modrinth identification, the store, safe updates
//! with backups and one-click rollback.

use super::util::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

const MR: &str = "https://api.modrinth.com/v2";

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ModMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub icon: Option<String>,
    pub loader: String,
    pub depends: Vec<String>,
    /// top-level class package prefixes (to tell which mod a crash came from)
    pub packages: Vec<String>,
    pub mixins: Vec<String>,
    pub homepage: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct MrInfo {
    pub project_id: String,
    pub version_id: String,
    pub version_number: String,
    pub slug: String,
    pub title: String,
    pub icon_url: Option<String>,
    pub downloads: i64,
    pub date: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstalledMod {
    pub file: String,
    pub enabled: bool,
    pub size: u64,
    pub mtime: i64,
    pub sha1: String,
    pub meta: ModMeta,
    pub modrinth: Option<MrInfo>,
}

pub fn mods_dir(mc_dir: &Path) -> PathBuf {
    mc_dir.join("mods")
}

fn lenient_json(s: &str) -> Option<Value> {
    serde_json::from_str(s).ok().or_else(|| {
        let cleaned: String = s.chars().map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c }).collect();
        serde_json::from_str(&cleaned).ok()
    })
}

fn str_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn people(v: Option<&Value>) -> Vec<String> {
    let mut out = vec![];
    match v {
        Some(Value::Array(a)) => {
            for p in a {
                if let Some(s) = p.as_str() {
                    out.push(s.to_string());
                } else if let Some(s) = p.get("name").and_then(|n| n.as_str()) {
                    out.push(s.to_string());
                }
            }
        }
        Some(Value::Object(o)) => out.extend(o.keys().cloned()),
        _ => {}
    }
    out
}

fn toml_field(text: &str, key: &str) -> String {
    let re = regex::Regex::new(&format!(r#"(?m)^\s*{key}\s*=\s*(?:"([^"]*)"|'''([\s\S]*?)'''|'([^']*)')"#)).unwrap();
    re.captures(text)
        .and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default()
}

pub fn read_jar_meta(path: &Path) -> ModMeta {
    let mut meta = ModMeta::default();
    let Ok(f) = std::fs::File::open(path) else { return meta };
    let Ok(mut z) = zip::ZipArchive::new(std::io::BufReader::new(f)) else { return meta };
    let mut read = |name: &str| -> Option<String> {
        let mut e = z.by_name(name).ok()?;
        let mut s = String::new();
        e.read_to_string(&mut s).ok()?;
        Some(s)
    };
    if let Some(v) = read("fabric.mod.json").and_then(|s| lenient_json(&s)) {
        meta.loader = "fabric".into();
        meta.id = str_of(v.get("id"));
        meta.name = str_of(v.get("name"));
        meta.version = str_of(v.get("version"));
        meta.description = str_of(v.get("description"));
        meta.authors = people(v.get("authors"));
        meta.icon = match v.get("icon") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => {
                let mut best: Option<(i64, String)> = None;
                for (k, p) in o {
                    let size = k.parse::<i64>().unwrap_or(0);
                    if let Some(p) = p.as_str() {
                        if best.as_ref().map(|b| (size - 128).abs() < (b.0 - 128).abs()).unwrap_or(true) {
                            best = Some((size, p.to_string()));
                        }
                    }
                }
                best.map(|b| b.1)
            }
            _ => None,
        };
        if let Some(d) = v.get("depends").and_then(|d| d.as_object()) {
            meta.depends = d.keys().filter(|k| !["minecraft", "java", "fabricloader"].contains(&k.as_str())).cloned().collect();
        }
        if let Some(m) = v.get("mixins").and_then(|m| m.as_array()) {
            for x in m {
                if let Some(s) = x.as_str() {
                    meta.mixins.push(s.to_string());
                } else if let Some(s) = x.get("config").and_then(|c| c.as_str()) {
                    meta.mixins.push(s.to_string());
                }
            }
        }
        meta.homepage = v.get("contact").and_then(|c| c.get("homepage")).and_then(|h| h.as_str()).map(|s| s.to_string());
    } else if let Some(v) = read("quilt.mod.json").and_then(|s| lenient_json(&s)) {
        meta.loader = "quilt".into();
        let ql = v.get("quilt_loader").cloned().unwrap_or(Value::Null);
        meta.id = str_of(ql.get("id"));
        meta.version = str_of(ql.get("version"));
        let md = ql.get("metadata").cloned().unwrap_or(Value::Null);
        meta.name = str_of(md.get("name"));
        meta.description = str_of(md.get("description"));
        meta.authors = people(md.get("contributors"));
        meta.icon = md.get("icon").and_then(|i| i.as_str()).map(|s| s.to_string());
    } else if let Some(t) = read("META-INF/neoforge.mods.toml").or_else(|| read("META-INF/mods.toml")) {
        meta.loader = "forge".into();
        meta.id = toml_field(&t, "modId");
        meta.name = toml_field(&t, "displayName");
        meta.version = toml_field(&t, "version");
        meta.description = toml_field(&t, "description");
        let a = toml_field(&t, "authors");
        if !a.is_empty() {
            meta.authors = vec![a];
        }
        let logo = toml_field(&t, "logoFile");
        if !logo.is_empty() {
            meta.icon = Some(logo);
        }
    }
    if meta.version.contains("${") {
        meta.version.clear();
    }
    // class packages
    let mut pk: HashSet<String> = HashSet::new();
    for i in 0..z.len() {
        if let Ok(e) = z.by_index_raw(i) {
            let n = e.name();
            if n.ends_with(".class") && !n.starts_with("META-INF") {
                let parts: Vec<&str> = n.split('/').collect();
                if parts.len() >= 3 {
                    let depth = if parts.len() >= 4 { 3 } else { 2 };
                    pk.insert(parts[..depth].join("."));
                }
                if pk.len() > 40 {
                    break;
                }
            }
        }
    }
    meta.packages = pk.into_iter().collect();
    if meta.name.is_empty() {
        meta.name = if meta.id.is_empty() {
            path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            meta.id.clone()
        };
    }
    meta
}

pub fn jar_file(path: &Path, inner: &str) -> Option<Vec<u8>> {
    let f = std::fs::File::open(path).ok()?;
    let mut z = zip::ZipArchive::new(std::io::BufReader::new(f)).ok()?;
    let mut e = z.by_name(inner.trim_start_matches('/')).ok()?;
    let mut b = vec![];
    e.read_to_end(&mut b).ok()?;
    Some(b)
}

#[derive(Serialize, Deserialize, Default)]
struct MetaCache {
    entries: HashMap<String, (String, ModMeta)>,
}

#[derive(Serialize, Deserialize, Default)]
struct MrCache {
    /// sha1 -> modrinth info (None = not on Modrinth)
    entries: HashMap<String, Option<MrInfo>>,
}

fn meta_cache_path() -> PathBuf {
    data_dir().join("cache").join("modmeta.json")
}
fn mr_cache_path() -> PathBuf {
    data_dir().join("cache").join("modrinth.json")
}

/// All mods in an instance, with metadata and (cached) Modrinth info.
pub fn installed(mc_dir: &Path) -> Vec<InstalledMod> {
    let dir = mods_dir(mc_dir);
    let mut cache: MetaCache = read_json(&meta_cache_path());
    let mr: MrCache = read_json(&mr_cache_path());
    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                    n.ends_with(".jar") || n.ends_with(".jar.disabled")
                })
                .collect()
        })
        .unwrap_or_default();
    use rayon::prelude::*;
    let mut dirty = false;
    let known: HashMap<String, (String, ModMeta)> = cache.entries.clone();
    let results: Vec<(String, InstalledMod, bool)> = files
        .par_iter()
        .map(|p| {
            let md = std::fs::metadata(p).ok();
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = mtime_ms(p);
            let file = p.file_name().unwrap().to_string_lossy().to_string();
            let key = format!("{}|{size}|{mtime}", p.to_string_lossy());
            let (sha1, meta, fresh) = match known.get(&key) {
                Some((h, m)) => (h.clone(), m.clone(), false),
                None => {
                    let bytes = std::fs::read(p).unwrap_or_default();
                    (sha1_hex(&bytes), read_jar_meta(p), true)
                }
            };
            let enabled = !file.to_lowercase().ends_with(".disabled");
            let modrinth = mr.entries.get(&sha1).cloned().flatten();
            (key, InstalledMod { file, enabled, size, mtime, sha1, meta, modrinth }, fresh)
        })
        .collect();
    let mut out = vec![];
    for (key, m, fresh) in results {
        if fresh {
            cache.entries.insert(key, (m.sha1.clone(), m.meta.clone()));
            dirty = true;
        }
        out.push(m);
    }
    if dirty {
        let _ = write_json(&meta_cache_path(), &cache);
    }
    out.sort_by(|a, b| a.meta.name.to_lowercase().cmp(&b.meta.name.to_lowercase()));
    out
}

fn mr_info_from(version: &Value, project: Option<&Value>) -> MrInfo {
    MrInfo {
        project_id: str_of(version.get("project_id")),
        version_id: str_of(version.get("id")),
        version_number: str_of(version.get("version_number")),
        date: str_of(version.get("date_published")),
        slug: project.map(|p| str_of(p.get("slug"))).unwrap_or_default(),
        title: project.map(|p| str_of(p.get("title"))).unwrap_or_default(),
        icon_url: project.and_then(|p| p.get("icon_url")).and_then(|i| i.as_str()).map(|s| s.to_string()),
        downloads: project.and_then(|p| p.get("downloads")).and_then(|d| d.as_i64()).unwrap_or(0),
    }
}

pub fn projects(ids: &[String]) -> anyhow::Result<HashMap<String, Value>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(80) {
        let list = serde_json::to_string(chunk)?;
        let url = format!("{MR}/projects?ids={}", urlenc(&list));
        if let Value::Array(a) = get_json(&url)? {
            for p in a {
                out.insert(str_of(p.get("id")), p);
            }
        }
    }
    Ok(out)
}

pub fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Look every installed jar up on Modrinth by its hash (one request for all of them).
pub fn identify(mc_dir: &Path, force: bool) -> anyhow::Result<()> {
    let mods = installed(mc_dir);
    let mut cache: MrCache = read_json(&mr_cache_path());
    let need: Vec<String> = mods.iter().map(|m| m.sha1.clone()).filter(|h| force || !cache.entries.contains_key(h)).collect();
    if need.is_empty() {
        return Ok(());
    }
    let res = post_json(&format!("{MR}/version_files"), &json!({ "hashes": need, "algorithm": "sha1" }))?;
    let mut versions: HashMap<String, Value> = HashMap::new();
    if let Value::Object(o) = res {
        for (h, v) in o {
            versions.insert(h, v);
        }
    }
    let pids: Vec<String> = versions.values().map(|v| str_of(v.get("project_id"))).collect::<HashSet<_>>().into_iter().collect();
    let projs = projects(&pids).unwrap_or_default();
    for h in need {
        let info = versions.get(&h).map(|v| mr_info_from(v, projs.get(&str_of(v.get("project_id")))));
        cache.entries.insert(h, info);
    }
    write_json(&mr_cache_path(), &cache)?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub file: String,
    pub name: String,
    pub project_id: String,
    pub icon_url: Option<String>,
    pub from: String,
    pub to: String,
    pub version_id: String,
    pub date: String,
    pub changelog: String,
    pub file_name: String,
    pub size: i64,
}

pub fn check_updates(mc_dir: &Path, loader: &str, mc_version: &str) -> anyhow::Result<Vec<UpdateInfo>> {
    identify(mc_dir, false)?;
    let mods = installed(mc_dir);
    let enabled: Vec<&InstalledMod> = mods.iter().filter(|m| m.enabled && m.modrinth.is_some()).collect();
    if enabled.is_empty() {
        return Ok(vec![]);
    }
    let hashes: Vec<String> = enabled.iter().map(|m| m.sha1.clone()).collect();
    let loaders = if loader == "quilt" { json!(["quilt", "fabric"]) } else { json!([loader]) };
    let res = post_json(&format!("{MR}/version_files/update"), &json!({ "hashes": hashes, "algorithm": "sha1", "loaders": loaders, "game_versions": [mc_version] }))?;
    let mut out = vec![];
    for m in enabled {
        let Some(v) = res.get(&m.sha1) else { continue };
        let cur = m.modrinth.as_ref().unwrap();
        let vid = str_of(v.get("id"));
        if vid.is_empty() || vid == cur.version_id {
            continue;
        }
        // only newer: compare publish dates
        let date = str_of(v.get("date_published"));
        if !cur.date.is_empty() && date <= cur.date {
            continue;
        }
        let f = primary_file(v);
        out.push(UpdateInfo {
            file: m.file.clone(),
            name: if cur.title.is_empty() { m.meta.name.clone() } else { cur.title.clone() },
            project_id: cur.project_id.clone(),
            icon_url: cur.icon_url.clone(),
            from: if m.meta.version.is_empty() { cur.version_number.clone() } else { m.meta.version.clone() },
            to: str_of(v.get("version_number")),
            version_id: vid,
            date,
            changelog: str_of(v.get("changelog")),
            file_name: f.as_ref().map(|f| str_of(f.get("filename"))).unwrap_or_default(),
            size: f.as_ref().and_then(|f| f.get("size")).and_then(|s| s.as_i64()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn primary_file(v: &Value) -> Option<Value> {
    let files = v.get("files")?.as_array()?;
    files.iter().find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false)).or(files.first()).cloned()
}

fn safe_name(n: &str) -> bool {
    !n.is_empty() && !n.contains('/') && !n.contains('\\') && !n.contains("..")
}

/// Download a Modrinth version's main file into the mods folder (hash-checked). Returns the file name.
fn download_version(mods: &Path, v: &Value) -> anyhow::Result<String> {
    let f = primary_file(v).ok_or_else(|| anyhow::anyhow!("that version has no file"))?;
    let url = str_of(f.get("url"));
    let name = str_of(f.get("filename"));
    if !safe_name(&name) || !name.to_lowercase().ends_with(".jar") {
        anyhow::bail!("unexpected file name {name}");
    }
    let bytes = get_bytes(&url)?;
    let want = f.get("hashes").and_then(|h| h.get("sha1")).and_then(|h| h.as_str()).unwrap_or("");
    if !want.is_empty() && sha1_hex(&bytes) != want {
        anyhow::bail!("{name} didn't download correctly (hash mismatch)");
    }
    std::fs::create_dir_all(mods)?;
    let tmp = mods.join(format!("{name}.part"));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, mods.join(&name))?;
    Ok(name)
}

// ------------------------------------------------------------------ backups

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Backup {
    pub id: String,
    pub time: i64,
    pub reason: String,
    pub files: Vec<String>,
}

fn backups_dir(inst: &str) -> PathBuf {
    data_dir().join("backups").join(inst)
}

pub fn backup(inst: &str, mc_dir: &Path, reason: &str) -> anyhow::Result<Backup> {
    let id = now_ms().to_string();
    let dir = backups_dir(inst).join(&id);
    std::fs::create_dir_all(dir.join("mods"))?;
    let mut files = vec![];
    if let Ok(rd) = std::fs::read_dir(mods_dir(mc_dir)) {
        for e in rd.flatten() {
            let p = e.path();
            let n = e.file_name().to_string_lossy().to_string();
            if p.is_file() && (n.to_lowercase().ends_with(".jar") || n.to_lowercase().ends_with(".disabled")) {
                std::fs::copy(&p, dir.join("mods").join(&n))?;
                files.push(n);
            }
        }
    }
    let b = Backup { id, time: now_ms(), reason: reason.to_string(), files };
    write_json(&dir.join("backup.json"), &b)?;
    // keep the 12 newest
    let mut all = list_backups(inst);
    if all.len() > 12 {
        all.sort_by_key(|b| b.time);
        for old in &all[..all.len() - 12] {
            let _ = std::fs::remove_dir_all(backups_dir(inst).join(&old.id));
        }
    }
    Ok(b)
}

pub fn list_backups(inst: &str) -> Vec<Backup> {
    let mut out: Vec<Backup> = std::fs::read_dir(backups_dir(inst))
        .map(|rd| rd.flatten().filter_map(|e| std::fs::read_to_string(e.path().join("backup.json")).ok()).filter_map(|t| serde_json::from_str(&t).ok()).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

pub fn rollback(inst: &str, mc_dir: &Path, id: &str) -> anyhow::Result<()> {
    if !id.chars().all(|c| c.is_ascii_digit()) {
        anyhow::bail!("bad backup id");
    }
    let src = backups_dir(inst).join(id).join("mods");
    if !src.is_dir() {
        anyhow::bail!("that backup is gone");
    }
    backup(inst, mc_dir, "Before rolling back")?;
    let mods = mods_dir(mc_dir);
    if let Ok(rd) = std::fs::read_dir(&mods) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if e.path().is_file() && (n.ends_with(".jar") || n.ends_with(".disabled")) {
                std::fs::remove_file(e.path())?;
            }
        }
    }
    for e in std::fs::read_dir(&src)?.flatten() {
        std::fs::copy(e.path(), mods.join(e.file_name()))?;
    }
    Ok(())
}

pub fn apply_updates(inst: &str, mc_dir: &Path, picks: &[(String, String)]) -> anyhow::Result<Vec<String>> {
    let b = backup(inst, mc_dir, &format!("Before updating {} mod{}", picks.len(), if picks.len() == 1 { "" } else { "s" }))?;
    let mods = mods_dir(mc_dir);
    let mut done = vec![];
    let mut errors = vec![];
    for (file, vid) in picks {
        if !safe_name(file) || !vid.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let r = (|| -> anyhow::Result<String> {
            let v = get_json(&format!("{MR}/version/{vid}"))?;
            let new = download_version(&mods, &v)?;
            if new != *file {
                let old = mods.join(file);
                if old.is_file() {
                    std::fs::remove_file(old)?;
                }
            }
            Ok(new)
        })();
        match r {
            Ok(n) => done.push(n),
            Err(e) => errors.push(format!("{file}: {e}")),
        }
    }
    let _ = identify(mc_dir, false);
    if !errors.is_empty() && done.is_empty() {
        let _ = rollback_files_only(inst, mc_dir, &b.id);
        anyhow::bail!("{}", errors.join("; "));
    }
    Ok(done)
}

fn rollback_files_only(inst: &str, mc_dir: &Path, id: &str) -> anyhow::Result<()> {
    let src = backups_dir(inst).join(id).join("mods");
    for e in std::fs::read_dir(&src)?.flatten() {
        std::fs::copy(e.path(), mods_dir(mc_dir).join(e.file_name()))?;
    }
    Ok(())
}

pub fn set_enabled(mc_dir: &Path, file: &str, enabled: bool) -> anyhow::Result<String> {
    if !safe_name(file) {
        anyhow::bail!("bad file");
    }
    let mods = mods_dir(mc_dir);
    let p = mods.join(file);
    let base = file.trim_end_matches(".disabled").to_string();
    let target = if enabled { base.clone() } else { format!("{base}.disabled") };
    if target != file {
        std::fs::rename(&p, mods.join(&target))?;
    }
    Ok(target)
}

pub fn remove(inst: &str, mc_dir: &Path, file: &str) -> anyhow::Result<()> {
    if !safe_name(file) {
        anyhow::bail!("bad file");
    }
    backup(inst, mc_dir, &format!("Before removing {}", file.trim_end_matches(".disabled")))?;
    let p = mods_dir(mc_dir).join(file);
    if trash::delete(&p).is_err() {
        std::fs::remove_file(&p)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ store

pub fn search(query: &str, offset: u32, sort: &str, category: Option<&str>, loader: &str, mc_version: &str) -> anyhow::Result<Value> {
    let mut facets = vec![vec!["project_type:mod".to_string()], vec![format!("categories:{loader}")]];
    if !mc_version.is_empty() {
        facets.push(vec![format!("versions:{mc_version}")]);
    }
    if let Some(c) = category.filter(|c| !c.is_empty()) {
        facets.push(vec![format!("categories:{c}")]);
    }
    let index = match sort {
        "downloads" | "follows" | "newest" | "updated" => sort,
        _ => "relevance",
    };
    let url = format!(
        "{MR}/search?query={}&limit=24&offset={offset}&index={index}&facets={}",
        urlenc(query),
        urlenc(&serde_json::to_string(&facets)?)
    );
    get_json(&url)
}

pub fn project(id: &str, loader: &str, mc_version: &str) -> anyhow::Result<Value> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        anyhow::bail!("bad project id");
    }
    let p = get_json(&format!("{MR}/project/{id}"))?;
    let vers = compat_versions(id, loader, mc_version).unwrap_or_default();
    let team = get_json(&format!("{MR}/project/{id}/members")).unwrap_or(Value::Null);
    let authors: Vec<String> = team.as_array().map(|a| a.iter().filter_map(|m| m.get("user").and_then(|u| u.get("username")).and_then(|u| u.as_str()).map(|s| s.to_string())).collect()).unwrap_or_default();
    Ok(json!({ "project": p, "versions": vers.into_iter().take(8).collect::<Vec<_>>(), "authors": authors }))
}

fn compat_versions(id: &str, loader: &str, mc_version: &str) -> anyhow::Result<Vec<Value>> {
    let loaders = if loader == "quilt" { "[\"quilt\",\"fabric\"]".to_string() } else { format!("[\"{loader}\"]") };
    let url = format!("{MR}/project/{id}/version?loaders={}&game_versions={}", urlenc(&loaders), urlenc(&format!("[\"{mc_version}\"]")));
    Ok(get_json(&url)?.as_array().cloned().unwrap_or_default())
}

fn pick_version(list: &[Value]) -> Option<Value> {
    list.iter().find(|v| str_of(v.get("version_type")) == "release").or(list.first()).cloned()
}

/// Install a project and everything it needs. Returns the names of the files added.
pub fn install(inst: &str, mc_dir: &Path, project_id: &str, loader: &str, mc_version: &str) -> anyhow::Result<Vec<String>> {
    identify(mc_dir, false).ok();
    let have: HashSet<String> = installed(mc_dir).into_iter().filter_map(|m| m.modrinth.map(|i| i.project_id)).collect();
    if have.contains(project_id) {
        anyhow::bail!("that mod is already installed");
    }
    let mods = mods_dir(mc_dir);
    let mut queue = vec![(project_id.to_string(), None::<String>)];
    let mut seen = HashSet::new();
    let mut added = vec![];
    let mut first = true;
    while let Some((pid, vid)) = queue.pop() {
        if !seen.insert(pid.clone()) || (have.contains(&pid) && !first) {
            continue;
        }
        let v = match vid {
            Some(v) if v.chars().all(|c| c.is_ascii_alphanumeric()) => get_json(&format!("{MR}/version/{v}"))?,
            _ => {
                let list = compat_versions(&pid, loader, mc_version)?;
                match pick_version(&list) {
                    Some(v) => v,
                    None => {
                        if first {
                            anyhow::bail!("no version of this mod works on {loader} {mc_version} yet");
                        }
                        continue;
                    }
                }
            }
        };
        if first {
            backup(inst, mc_dir, "Before installing a mod")?;
            first = false;
        }
        added.push(download_version(&mods, &v)?);
        for d in v.get("dependencies").and_then(|d| d.as_array()).cloned().unwrap_or_default() {
            if str_of(d.get("dependency_type")) != "required" {
                continue;
            }
            let dp = str_of(d.get("project_id"));
            let dv = d.get("version_id").and_then(|x| x.as_str()).map(|s| s.to_string());
            if !dp.is_empty() && !have.contains(&dp) {
                queue.push((dp, dv));
            }
        }
    }
    let _ = identify(mc_dir, false);
    Ok(added)
}
