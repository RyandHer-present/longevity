//! The full Modrinth store: mods, shaders, resource packs, datapacks and modpacks, the Saved list,
//! and the resource packs and shader packs already in an instance.

use super::mods::{self, urlenc};
use super::util::*;
use super::{perf, prism};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MR: &str = "https://api.modrinth.com/v2";
pub const IRIS: &str = "YL57xq9U";
pub const SODIUM: &str = "AANobbMI";

pub fn check_kind(k: &str) -> anyhow::Result<()> {
    match k {
        "mod" | "shader" | "resourcepack" | "datapack" | "modpack" => Ok(()),
        _ => anyhow::bail!("unknown kind of project"),
    }
}

fn str_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn safe_facet(f: &str) -> bool {
    let Some((k, v)) = f.split_once(':') else { return false };
    matches!(k, "categories" | "versions") && !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

fn loader_facet(loader: &str) -> Vec<String> {
    if loader == "quilt" { vec!["categories:quilt".into(), "categories:fabric".into()] } else { vec![format!("categories:{loader}")] }
}

pub fn loader_label(l: &str) -> &str {
    match l {
        "fabric" => "Fabric",
        "neoforge" => "NeoForge",
        "forge" => "Forge",
        "quilt" => "Quilt",
        _ => "Minecraft",
    }
}

/// Search one kind of project. Versions aren't filtered here, so the store can grey out
/// things that don't fit the instance instead of hiding them.
pub fn search(kind: &str, query: &str, offset: u32, limit: u32, sort: &str, filters: &[Vec<String>], loader: &str) -> anyhow::Result<Value> {
    check_kind(kind)?;
    let mut facets = vec![vec![format!("project_type:{kind}")]];
    match kind {
        "mod" if loader != "vanilla" => facets.push(loader_facet(loader)),
        "shader" => facets.push(vec!["categories:iris".into()]),
        _ => {}
    }
    for group in filters {
        let g: Vec<String> = group.iter().filter(|f| safe_facet(f)).cloned().collect();
        if !g.is_empty() {
            facets.push(g);
        }
    }
    let index = match sort {
        "downloads" | "follows" | "newest" | "updated" => sort,
        _ => "relevance",
    };
    let url = format!(
        "{MR}/search?query={}&limit={}&offset={offset}&index={index}&facets={}",
        urlenc(query),
        limit.clamp(1, 40),
        urlenc(&serde_json::to_string(&facets)?)
    );
    get_json(&url)
}

fn versions_for(id: &str, loaders: Option<&[&str]>, mc: Option<&str>) -> anyhow::Result<Vec<Value>> {
    let mut url = format!("{MR}/project/{id}/version?include_changelog=false");
    if let Some(l) = loaders {
        url.push_str(&format!("&loaders={}", urlenc(&serde_json::to_string(l)?)));
    }
    if let Some(m) = mc.filter(|m| !m.is_empty()) {
        url.push_str(&format!("&game_versions={}", urlenc(&format!("[\"{m}\"]"))));
    }
    Ok(get_json(&url)?.as_array().cloned().unwrap_or_default())
}

/// The versions of a project that work on this instance, newest first.
pub fn compat_versions(kind: &str, id: &str, loader: &str, mc: &str) -> anyhow::Result<Vec<Value>> {
    let ld: Vec<&str> = if loader == "quilt" { vec!["quilt", "fabric"] } else { vec![loader] };
    match kind {
        "mod" => versions_for(id, Some(&ld), Some(mc)),
        "shader" => versions_for(id, Some(&["iris"]), Some(mc)),
        "datapack" => versions_for(id, Some(&["datapack"]), Some(mc)),
        "resourcepack" => versions_for(id, None, Some(mc)),
        _ => versions_for(id, None, None),
    }
}

pub fn project(kind: &str, id: &str, loader: &str, mc: &str) -> anyhow::Result<Value> {
    check_kind(kind)?;
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        anyhow::bail!("bad project id");
    }
    let p = get_json(&format!("{MR}/project/{id}"))?;
    let vers = compat_versions(kind, id, loader, mc).unwrap_or_default();
    let team = get_json(&format!("{MR}/project/{id}/members")).unwrap_or(Value::Null);
    let authors: Vec<String> = team.as_array().map(|a| a.iter().filter_map(|m| m.get("user").and_then(|u| u.get("username")).and_then(|u| u.as_str()).map(|s| s.to_string())).collect()).unwrap_or_default();
    Ok(json!({ "project": p, "versions": vers.into_iter().take(8).collect::<Vec<_>>(), "authors": authors }))
}

pub fn pick_version(list: &[Value]) -> Option<Value> {
    list.iter().find(|v| str_of(v.get("version_type")) == "release").or(list.first()).cloned()
}

pub fn primary_file(v: &Value) -> Option<Value> {
    let files = v.get("files")?.as_array()?;
    files.iter().find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false)).or(files.first()).cloned()
}

fn safe_name(n: &str) -> bool {
    !n.is_empty() && !n.contains('/') && !n.contains('\\') && !n.contains("..") && !n.contains(':')
}

/// Download a version's main file into `dir` (hash-checked). Returns the file name.
pub fn download_into(dir: &Path, v: &Value, exts: &[&str]) -> anyhow::Result<String> {
    let f = primary_file(v).ok_or_else(|| anyhow::anyhow!("that version has no file"))?;
    let url = str_of(f.get("url"));
    let name = str_of(f.get("filename"));
    if !safe_name(&name) || !exts.iter().any(|e| name.to_lowercase().ends_with(e)) {
        anyhow::bail!("unexpected file name {name}");
    }
    let bytes = get_bytes(&url)?;
    let want = f.get("hashes").and_then(|h| h.get("sha1")).and_then(|h| h.as_str()).unwrap_or("");
    if !want.is_empty() && sha1_hex(&bytes) != want {
        anyhow::bail!("{name} didn't download correctly (hash mismatch)");
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.part"));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, dir.join(&name))?;
    Ok(name)
}

fn installed_projects(mc: &Path) -> HashSet<String> {
    mods::identify(mc, false).ok();
    mods::installed(mc).into_iter().filter(|m| m.enabled).filter_map(|m| m.modrinth.map(|i| i.project_id)).collect()
}

/// Shaders need Iris (and Sodium). Adds whichever is missing. Returns the files added.
pub fn ensure_iris(i: &prism::Instance) -> anyhow::Result<Vec<String>> {
    if i.loader == "vanilla" {
        anyhow::bail!("Shaders need a mod loader, and this instance is plain Minecraft");
    }
    let mc = PathBuf::from(&i.mc_dir);
    let have = installed_projects(&mc);
    let mut added = vec![];
    for (pid, name) in [(SODIUM, "Sodium"), (IRIS, "Iris")] {
        if have.contains(pid) {
            continue;
        }
        match mods::install(&i.id, &mc, pid, &i.loader, &i.mc_version) {
            Ok(f) => added.extend(f),
            Err(e) if e.to_string().contains("already installed") => {}
            Err(e) if e.to_string().contains("no version") => anyhow::bail!("{name} (shaders need it) isn't out for {} {} yet", loader_label(&i.loader), i.mc_version),
            Err(e) => return Err(e),
        }
    }
    Ok(added)
}

/// Install anything from the store into an instance. Returns the files added.
pub fn install(kind: &str, i: &prism::Instance, project_id: &str, world: Option<&str>) -> anyhow::Result<Vec<String>> {
    check_kind(kind)?;
    if !project_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        anyhow::bail!("bad project id");
    }
    let mc = PathBuf::from(&i.mc_dir);
    match kind {
        "mod" => mods::install(&i.id, &mc, project_id, &i.loader, &i.mc_version),
        "shader" => {
            let v = pick_version(&compat_versions(kind, project_id, &i.loader, &i.mc_version)?).ok_or_else(|| anyhow::anyhow!("no version of this shader works on {} yet", i.mc_version))?;
            let mut added = ensure_iris(i)?;
            let name = download_into(&mc.join("shaderpacks"), &v, &[".zip"])?;
            perf::use_shader_pack(i, &name)?;
            added.insert(0, name);
            Ok(added)
        }
        "resourcepack" => {
            let v = pick_version(&compat_versions(kind, project_id, &i.loader, &i.mc_version)?).ok_or_else(|| anyhow::anyhow!("no version of this pack is made for {} yet", i.mc_version))?;
            Ok(vec![download_into(&mc.join("resourcepacks"), &v, &[".zip"])?])
        }
        "datapack" => {
            let w = world.filter(|w| prism::safe_id(w)).ok_or_else(|| anyhow::anyhow!("pick a world for the datapack"))?;
            let wd = mc.join("saves").join(w);
            if !wd.join("level.dat").is_file() {
                anyhow::bail!("that world isn't there anymore");
            }
            let v = pick_version(&compat_versions(kind, project_id, &i.loader, &i.mc_version)?).ok_or_else(|| anyhow::anyhow!("no datapack version of this works on {} yet", i.mc_version))?;
            Ok(vec![download_into(&wd.join("datapacks"), &v, &[".zip"])?])
        }
        _ => anyhow::bail!("modpacks install as a new instance"),
    }
}

// ------------------------------------------------------------------ saved list

#[derive(Serialize, Deserialize, Default)]
struct SavedFile {
    items: Vec<Value>,
}

fn saved_path() -> PathBuf {
    data_dir().join("saved.json")
}

pub fn saved() -> Vec<Value> {
    read_json::<SavedFile>(&saved_path()).items
}

/// Heart or un-heart a store card. `hit` is the search result (with its project_type).
pub fn saved_toggle(hit: Value) -> anyhow::Result<Vec<Value>> {
    let id = str_of(hit.get("project_id"));
    if id.is_empty() {
        anyhow::bail!("bad project");
    }
    let mut f: SavedFile = read_json(&saved_path());
    let before = f.items.len();
    f.items.retain(|x| str_of(x.get("project_id")) != id);
    if f.items.len() == before {
        let mut h = hit;
        if let Some(o) = h.as_object_mut() {
            o.insert("saved_at".into(), json!(now_ms()));
        }
        f.items.insert(0, h);
    }
    write_json(&saved_path(), &f)?;
    Ok(f.items)
}

// ------------------------------------------------------------------ packs in an instance

#[derive(Serialize, Clone, Debug)]
pub struct Pack {
    pub file: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub size: u64,
    pub mtime: i64,
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text_of).collect(),
        Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(e) = o.get("extra") {
                s.push_str(&text_of(e));
            }
            s
        }
        _ => String::new(),
    }
}

fn read_in_pack(path: &Path, inner: &str) -> Option<Vec<u8>> {
    if path.is_dir() {
        return std::fs::read(path.join(inner)).ok();
    }
    let f = std::fs::File::open(path).ok()?;
    let mut z = zip::ZipArchive::new(std::io::BufReader::new(f)).ok()?;
    let mut e = z.by_name(inner).ok()?;
    let mut b = vec![];
    e.read_to_end(&mut b).ok()?;
    Some(b)
}

fn dir_of(mc: &Path, kind: &str) -> anyhow::Result<PathBuf> {
    Ok(match kind {
        "resourcepack" => mc.join("resourcepacks"),
        "shader" => mc.join("shaderpacks"),
        _ => anyhow::bail!("unknown pack kind"),
    })
}

pub fn pack_icon(mc: &Path, kind: &str, file: &str) -> Option<Vec<u8>> {
    if !safe_name(file) {
        return None;
    }
    let p = dir_of(mc, kind).ok()?.join(file);
    read_in_pack(&p, "pack.png")
}

fn options_path(mc: &Path) -> PathBuf {
    mc.join("options.txt")
}

fn enabled_packs(mc: &Path) -> Vec<String> {
    let t = std::fs::read_to_string(options_path(mc)).unwrap_or_default();
    t.lines()
        .find_map(|l| l.strip_prefix("resourcePacks:"))
        .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
        .unwrap_or_else(|| vec!["vanilla".into()])
}

fn list_dir(dir: &Path, f: impl Fn(&str, &Path) -> bool) -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| (e.file_name().to_string_lossy().to_string(), e.path())).filter(|(n, p)| f(n, p)).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    v
}

fn size_of(p: &Path) -> u64 {
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| size_of(&e.path())).sum()).unwrap_or(0)
}

fn pretty(file: &str) -> String {
    file.trim_end_matches(".zip").replace(['_', '+'], " ").trim().to_string()
}

fn strip_codes(s: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for c in s.chars() {
        if skip {
            skip = false;
            continue;
        }
        if c == '§' {
            skip = true;
            continue;
        }
        out.push(c);
    }
    out
}

pub fn resource_packs(mc: &Path) -> Vec<Pack> {
    let on = enabled_packs(mc);
    list_dir(&mc.join("resourcepacks"), |n, p| n.to_lowercase().ends_with(".zip") || p.join("pack.mcmeta").is_file())
        .into_iter()
        .map(|(file, p)| {
            let meta = read_in_pack(&p, "pack.mcmeta").and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            Pack {
                description: strip_codes(&meta.as_ref().and_then(|m| m.get("pack")).and_then(|p| p.get("description")).map(text_of).unwrap_or_default()),
                enabled: on.iter().any(|x| x == &format!("file/{file}")),
                name: pretty(&file),
                size: size_of(&p),
                mtime: mtime_ms(&p),
                file,
            }
        })
        .collect()
}

pub fn shader_list(i: &prism::Instance) -> Vec<Pack> {
    let mc = PathBuf::from(&i.mc_dir);
    let active = perf::state(i).shaders.shader_pack;
    list_dir(&mc.join("shaderpacks"), |n, p| n.to_lowercase().ends_with(".zip") || (p.is_dir() && p.join("shaders").is_dir()))
        .into_iter()
        .map(|(file, p)| Pack { enabled: file == active, name: pretty(&file), description: String::new(), size: size_of(&p), mtime: mtime_ms(&p), file })
        .collect()
}

/// Turn a resource pack on or off in options.txt. Packs turned on go on top of the others.
pub fn set_resource_pack(mc: &Path, file: &str, on: bool) -> anyhow::Result<()> {
    if !safe_name(file) {
        anyhow::bail!("bad file");
    }
    let key = format!("file/{file}");
    let mut list = enabled_packs(mc);
    list.retain(|x| x != &key);
    if on {
        list.push(key.clone());
    }
    let path = options_path(mc);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let val = format!("resourcePacks:{}", serde_json::to_string(&list)?);
    match lines.iter_mut().find(|l| l.starts_with("resourcePacks:")) {
        Some(l) => *l = val,
        None => lines.push(val),
    }
    // the game also remembers packs it warned about; forget ours when it's turned off
    if !on {
        for l in lines.iter_mut().filter(|l| l.starts_with("incompatibleResourcePacks:")) {
            if let Ok(mut v) = serde_json::from_str::<Vec<String>>(&l["incompatibleResourcePacks:".len()..]) {
                v.retain(|x| x != &key);
                *l = format!("incompatibleResourcePacks:{}", serde_json::to_string(&v)?);
            }
        }
    }
    let mut s = lines.join("\n");
    s.push('\n');
    std::fs::write(&path, s)?;
    Ok(())
}

pub fn delete_pack(mc: &Path, kind: &str, file: &str) -> anyhow::Result<()> {
    if !safe_name(file) {
        anyhow::bail!("bad file");
    }
    let p = dir_of(mc, kind)?.join(file);
    if !p.exists() {
        anyhow::bail!("that pack is already gone");
    }
    if kind == "resourcepack" {
        let _ = set_resource_pack(mc, file, false);
    }
    trash::delete(&p).map_err(|e| anyhow::anyhow!("couldn't move it to the Recycle Bin: {e}"))?;
    Ok(())
}
