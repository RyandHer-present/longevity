//! Making and managing instances without opening Prism: the new-instance wizard, Modrinth modpacks
//! (.mrpack) in and out, duplicate, rename, delete, memory and Java, and safe version upgrades.
//! Instances are written in Prism's own format, so Prism sees them like any other.

use super::mods::{self, urlenc};
use super::util::*;
use super::{perf, prism, store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

const META: &str = "https://meta.prismlauncher.org/v1";
const MR: &str = "https://api.modrinth.com/v2";

pub type Progress<'a> = &'a (dyn Fn(f32, &str) + Sync);

fn str_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

// ------------------------------------------------------------------ Prism's version lists

fn meta_index(uid: &str) -> anyhow::Result<Value> {
    let p = data_dir().join("cache").join("meta").join(format!("{uid}.json"));
    if mtime_ms(&p) > now_ms() - 3 * 3600 * 1000 {
        if let Ok(v) = serde_json::from_str::<Value>(&std::fs::read_to_string(&p).unwrap_or_default()) {
            return Ok(v);
        }
    }
    match get_json(&format!("{META}/{uid}/index.json")) {
        Ok(v) => {
            let _ = write_json(&p, &v);
            Ok(v)
        }
        // offline: an old list is better than none
        Err(e) => std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(e),
    }
}

fn versions_of(uid: &str) -> Vec<Value> {
    meta_index(uid).ok().and_then(|v| v.get("versions").and_then(|v| v.as_array()).cloned()).unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct McVersion {
    pub version: String,
    pub kind: String,
    pub released: String,
}

/// Every Minecraft version Prism knows: releases, snapshots, experiments and the old alphas and betas.
pub fn mc_versions() -> anyhow::Result<Vec<McVersion>> {
    let list = versions_of("net.minecraft");
    if list.is_empty() {
        anyhow::bail!("Couldn't get the list of Minecraft versions. Check your internet.");
    }
    Ok(list.iter().map(|v| McVersion { version: str_of(v.get("version")), kind: str_of(v.get("type")), released: str_of(v.get("releaseTime")) }).collect())
}

#[derive(Serialize, Clone)]
pub struct LoaderChoice {
    pub loader: String,
    pub version: Option<String>,
}

fn requires_mc(v: &Value, mc: &str) -> bool {
    v.get("requires").and_then(|r| r.as_array()).map(|r| r.iter().any(|x| str_of(x.get("uid")) == "net.minecraft" && str_of(x.get("equals")) == mc)).unwrap_or(false)
}

pub fn fabric_version() -> Option<String> {
    let list = versions_of("net.fabricmc.fabric-loader");
    list.iter().find(|v| v.get("recommended").and_then(|r| r.as_bool()).unwrap_or(false)).or(list.first()).map(|v| str_of(v.get("version")))
}

pub fn fabric_supports(mc: &str) -> bool {
    versions_of("net.fabricmc.intermediary").iter().any(|v| str_of(v.get("version")) == mc)
}

pub fn neoforge_for(mc: &str) -> Option<String> {
    let list: Vec<Value> = versions_of("net.neoforged").into_iter().filter(|v| requires_mc(v, mc)).collect();
    let stable = list.iter().find(|v| !str_of(v.get("version")).contains("beta"));
    stable.or(list.first()).map(|v| str_of(v.get("version")))
}

/// Which of the two loaders work on a Minecraft version, and the version of each to use.
pub fn loaders_for(mc: &str) -> Vec<LoaderChoice> {
    vec![
        LoaderChoice { loader: "fabric".into(), version: if fabric_supports(mc) { fabric_version() } else { None } },
        LoaderChoice { loader: "neoforge".into(), version: neoforge_for(mc) },
    ]
}

// ------------------------------------------------------------------ instance files

/// Prism's component list. Prism fills in the rest (LWJGL and so on) the first time it loads it.
pub fn write_pack(dir: &Path, mc: &str, loader: &str, lv: &str) -> anyhow::Result<()> {
    let mut comps = vec![json!({ "uid": "net.minecraft", "version": mc, "important": true })];
    let inter = json!({ "uid": "net.fabricmc.intermediary", "version": mc, "dependencyOnly": true });
    match loader {
        "fabric" => {
            comps.push(inter);
            comps.push(json!({ "uid": "net.fabricmc.fabric-loader", "version": lv }));
        }
        "quilt" => {
            comps.push(inter);
            comps.push(json!({ "uid": "org.quiltmc.quilt-loader", "version": lv }));
        }
        "neoforge" => comps.push(json!({ "uid": "net.neoforged", "version": lv })),
        "forge" => comps.push(json!({ "uid": "net.minecraftforge", "version": lv })),
        _ => {}
    }
    std::fs::write(dir.join("mmc-pack.json"), serde_json::to_vec_pretty(&json!({ "components": comps, "formatVersion": 1 }))?)?;
    Ok(())
}

fn new_uuid(seed: &str) -> String {
    sha1_hex(format!("{}|{seed}|{:?}", now_ms(), std::time::Instant::now()).as_bytes())[..32].to_string()
}

fn clean_name(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_alphanumeric() || " -_.()+[]'".contains(*c)).collect();
    let s = s.trim().trim_matches('.').trim().to_string();
    if s.is_empty() { "Instance".into() } else { s.chars().take(60).collect() }
}

/// A folder name for a new instance that isn't taken yet.
/// A name and folder no other instance uses: "Pack", then "Pack (2)", "Pack (3)"...
pub fn free_name(name: &str) -> (String, String) {
    let names: Vec<String> = prism::instances().into_iter().map(|i| i.name.to_lowercase()).collect();
    let root = prism::instances_dir();
    for n in 1..999 {
        let cand = if n == 1 { name.to_string() } else { format!("{name} ({n})") };
        let folder = clean_name(&cand);
        if !names.contains(&cand.to_lowercase()) && !root.join(&folder).exists() {
            return (cand, folder);
        }
    }
    (name.to_string(), unique_id(name))
}

pub fn unique_id(name: &str) -> String {
    let base = clean_name(name);
    let root = prism::instances_dir();
    let taken = |s: &str| root.join(s).exists() || root.read_dir().map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(s))).unwrap_or(false);
    if !taken(&base) {
        return base;
    }
    (2..999).map(|n| format!("{base} ({n})")).find(|s| !taken(s)).unwrap_or_else(|| format!("{base} {}", now_ms()))
}

fn write_cfg(dir: &Path, name: &str, icon: &str, extra: &[(&str, String)]) -> anyhow::Result<()> {
    let mut s = String::from("[General]\nConfigVersion=1.3\nInstanceType=OneSix\n");
    s.push_str(&format!("name={name}\niconKey={icon}\nuuid={}\nManagedPack=false\n", new_uuid(name)));
    for (k, v) in extra {
        s.push_str(&format!("{k}={v}\n"));
    }
    std::fs::write(dir.join("instance.cfg"), s)?;
    Ok(())
}

fn icons_dir() -> PathBuf {
    let d = prism::data_dir().join("icons");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Save an icon into Prism's icons folder and return its key.
pub fn save_icon(bytes: &[u8], key: &str, ext: &str) -> anyhow::Result<String> {
    let key: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let ext = ext.to_lowercase();
    let (data, ext) = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "ico" => (bytes.to_vec(), ext),
        // webp and the rest become PNG, which Prism always shows
        _ => {
            let img = image::load_from_memory(bytes).map_err(|_| anyhow::anyhow!("icons can be png, jpg, gif or webp"))?;
            let mut out = std::io::Cursor::new(Vec::new());
            img.write_to(&mut out, image::ImageFormat::Png)?;
            (out.into_inner(), "png".to_string())
        }
    };
    std::fs::write(icons_dir().join(format!("{key}.{ext}")), data)?;
    Ok(key)
}

pub fn icon_from_item(assets: &mcassets::Assets, item: &str) -> anyhow::Result<String> {
    let img = mcassets::icons::item_icon(assets, item, 128).ok_or_else(|| anyhow::anyhow!("can't draw that item"))?;
    let png = crate::tiles::png_bytes(&img);
    save_icon(&png, &format!("mio_{}", item.trim_start_matches("minecraft:")), "png")
}

pub fn icon_from_file(path: &str) -> anyhow::Result<String> {
    let p = PathBuf::from(path);
    let bytes = std::fs::read(&p)?;
    if bytes.len() > 8 << 20 {
        anyhow::bail!("that image is too big for an icon");
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    save_icon(&bytes, &format!("mio_{}", &sha1_hex(&bytes)[..10]), &ext)
}

#[derive(Serialize)]
pub struct ItemName {
    pub id: String,
    pub name: String,
}

/// Every item in the game, for the icon picker.
pub fn items(assets: &mcassets::Assets) -> Vec<ItemName> {
    let mut v: Vec<ItemName> = assets
        .jar
        .list("items/")
        .filter_map(|p| p.strip_prefix("items/")?.strip_suffix(".json").map(|s| s.to_string()))
        .filter(|id| !id.contains('/') && id != "air")
        .map(|id| ItemName { name: assets.lang.name(&id), id })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

// ------------------------------------------------------------------ new instance

#[derive(Deserialize)]
pub struct NewInstance {
    pub name: String,
    pub mc: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub icon_item: Option<String>,
    pub icon_file: Option<String>,
    pub copy_from: Option<String>,
    pub starter: Vec<String>,
}

const STARTER: [&str; 5] = ["sodium", "lithium", "ferrite-core", "modmenu", "iris"];

/// The starter kit for a version and loader: which of the five performance mods exist for it.
pub fn starter_kit(mc: &str, loader: &str) -> anyhow::Result<Vec<Value>> {
    let ids = serde_json::to_string(&STARTER)?;
    let list = get_json(&format!("{MR}/projects?ids={}", urlenc(&ids)))?;
    let mut by_slug: HashMap<String, Value> = HashMap::new();
    for p in list.as_array().cloned().unwrap_or_default() {
        by_slug.insert(str_of(p.get("slug")), p);
    }
    let mut out = vec![];
    for slug in STARTER {
        let Some(p) = by_slug.get(slug) else { continue };
        let pid = str_of(p.get("id"));
        let ok = loader != "vanilla" && !store::compat_versions("mod", &pid, loader, mc).unwrap_or_default().is_empty();
        out.push(json!({
            "project_id": pid, "slug": slug, "title": p.get("title"), "description": p.get("description"),
            "icon_url": p.get("icon_url"), "available": ok,
        }));
    }
    Ok(out)
}

fn copy_options(from: &prism::Instance, to_mc: &Path) -> anyhow::Result<()> {
    let src = PathBuf::from(&from.mc_dir).join("options.txt");
    let Ok(t) = std::fs::read_to_string(&src) else { return Ok(()) };
    // keybinds, video, sound and controls; not the resource packs (they aren't in the new instance)
    let kept: Vec<&str> = t.lines().filter(|l| !l.starts_with("resourcePacks:") && !l.starts_with("incompatibleResourcePacks:")).collect();
    std::fs::create_dir_all(to_mc)?;
    std::fs::write(to_mc.join("options.txt"), kept.join("\n") + "\n")?;
    Ok(())
}

/// Make a brand-new instance. Returns its id and anything that didn't work (like a starter mod).
pub fn create(spec: NewInstance, assets: Option<&mcassets::Assets>, progress: Progress) -> anyhow::Result<Value> {
    let name = spec.name.trim();
    if name.is_empty() {
        anyhow::bail!("give it a name");
    }
    if spec.mc.is_empty() || !spec.mc.chars().all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c)) {
        anyhow::bail!("pick a Minecraft version");
    }
    let (loader, lv) = match spec.loader.as_str() {
        "fabric" => ("fabric", spec.loader_version.clone().or_else(fabric_version).ok_or_else(|| anyhow::anyhow!("couldn't find Fabric's version list"))?),
        "neoforge" => ("neoforge", spec.loader_version.clone().or_else(|| neoforge_for(&spec.mc)).ok_or_else(|| anyhow::anyhow!("NeoForge isn't out for {} yet", spec.mc))?),
        _ => ("vanilla", String::new()),
    };
    progress(0.05, "Making the instance");
    let id = unique_id(name);
    let dir = prism::instances_dir().join(&id);
    std::fs::create_dir_all(dir.join("minecraft"))?;
    let result = (|| -> anyhow::Result<Value> {
        let mut warnings = vec![];
        let icon = match (&spec.icon_item, &spec.icon_file, assets) {
            (_, Some(f), _) => icon_from_file(f).unwrap_or_else(|e| {
                warnings.push(format!("icon: {e}"));
                "default".into()
            }),
            (Some(item), _, Some(a)) => icon_from_item(a, item).unwrap_or_else(|_| "default".into()),
            _ => "default".into(),
        };
        write_cfg(&dir, name, &icon, &[])?;
        write_pack(&dir, &spec.mc, loader, &lv)?;
        if let Some(from) = spec.copy_from.as_deref().filter(|s| !s.is_empty()).and_then(prism::instance) {
            progress(0.12, &format!("Copying your settings from {}", from.name));
            copy_options(&from, &dir.join("minecraft"))?;
        }
        let mc = dir.join("minecraft");
        let n = spec.starter.len().max(1) as f32;
        for (k, pid) in spec.starter.iter().enumerate() {
            if loader == "vanilla" {
                break;
            }
            progress(0.2 + 0.75 * (k as f32 / n), "Adding the starter mods");
            match mods::install(&id, &mc, pid, loader, &spec.mc) {
                Ok(_) => {}
                Err(e) if e.to_string().contains("already installed") => {}
                Err(e) => warnings.push(e.to_string()),
            }
        }
        progress(1.0, "Done");
        Ok(json!({ "id": id, "warnings": warnings }))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

// ------------------------------------------------------------------ modpacks (.mrpack)

#[derive(Clone, Debug)]
struct PackFile {
    path: PathBuf,
    url: String,
    sha1: String,
    sha512: String,
    size: u64,
}

struct PackIndex {
    name: String,
    version: String,
    summary: String,
    files: Vec<PackFile>,
    deps: HashMap<String, String>,
}

fn safe_rel(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.contains(':') || p.starts_with('/') || p.starts_with('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in Path::new(p).components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return None,
        }
    }
    Some(out)
}

fn read_index(path: &Path) -> anyhow::Result<PackIndex> {
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|_| anyhow::anyhow!("that file isn't a modpack"))?;
    let mut s = String::new();
    z.by_name("modrinth.index.json").map_err(|_| anyhow::anyhow!("that isn't a Modrinth modpack"))?.read_to_string(&mut s)?;
    let v: Value = serde_json::from_str(&s)?;
    let mut files = vec![];
    for f in v.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default() {
        let client = f.get("env").and_then(|e| e.get("client")).and_then(|c| c.as_str()).unwrap_or("required");
        if client == "unsupported" {
            continue;
        }
        let Some(rel) = safe_rel(&str_of(f.get("path"))) else { continue };
        let url = f.get("downloads").and_then(|d| d.as_array()).and_then(|d| d.iter().filter_map(|u| u.as_str()).find(|u| u.starts_with("https://"))).unwrap_or("").to_string();
        if url.is_empty() {
            continue;
        }
        let h = f.get("hashes").cloned().unwrap_or(Value::Null);
        files.push(PackFile { path: rel, url, sha1: str_of(h.get("sha1")), sha512: str_of(h.get("sha512")), size: f.get("fileSize").and_then(|s| s.as_u64()).unwrap_or(0) });
    }
    let deps: HashMap<String, String> = v.get("dependencies").and_then(|d| d.as_object()).map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
    Ok(PackIndex { name: str_of(v.get("name")), version: str_of(v.get("versionId")), summary: str_of(v.get("summary")), files, deps })
}

fn pack_loader(deps: &HashMap<String, String>) -> (String, String) {
    for (k, l) in [("fabric-loader", "fabric"), ("quilt-loader", "quilt"), ("neoforge", "neoforge"), ("forge", "forge")] {
        if let Some(v) = deps.get(k) {
            return (l.into(), v.clone());
        }
    }
    ("vanilla".into(), String::new())
}

/// Mio's guess at the memory a pack needs, from how many mods it has.
pub fn memory_for(mods: usize) -> i64 {
    match mods {
        0..=15 => 3072,
        16..=60 => 4096,
        61..=140 => 6144,
        141..=250 => 8192,
        _ => 10240,
    }
}

/// Where a modpack comes from: a Modrinth version, or a file on this PC.
#[derive(Deserialize, Clone)]
pub struct PackSource {
    pub version_id: Option<String>,
    pub path: Option<String>,
}

fn source_file(src: &PackSource) -> anyhow::Result<(PathBuf, Option<Value>)> {
    if let Some(p) = &src.path {
        let p = PathBuf::from(p);
        if !p.is_file() {
            anyhow::bail!("that file isn't there anymore");
        }
        // ask Modrinth which pack this file is (for its icon and version name); fine if it isn't one
        let version = std::fs::read(&p).ok().and_then(|b| get_json(&format!("{MR}/version_file/{}?algorithm=sha1", sha1_hex(&b))).ok());
        return Ok((p, version));
    }
    let vid = src.version_id.clone().filter(|v| v.chars().all(|c| c.is_ascii_alphanumeric()) && !v.is_empty()).ok_or_else(|| anyhow::anyhow!("bad modpack version"))?;
    let v = get_json(&format!("{MR}/version/{vid}"))?;
    let cache = data_dir().join("cache").join("mrpack").join(format!("{vid}.mrpack"));
    if !cache.is_file() {
        let f = store::primary_file(&v).ok_or_else(|| anyhow::anyhow!("that modpack version has no file"))?;
        let bytes = get_bytes(&str_of(f.get("url")))?;
        let want = f.get("hashes").and_then(|h| h.get("sha1")).and_then(|h| h.as_str()).unwrap_or("");
        if !want.is_empty() && sha1_hex(&bytes) != want {
            anyhow::bail!("the modpack didn't download correctly");
        }
        std::fs::create_dir_all(cache.parent().unwrap())?;
        std::fs::write(&cache, bytes)?;
    }
    Ok((cache, Some(v)))
}

fn modrinth_pid(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://cdn.modrinth.com/data/")?;
    Some(rest.split('/').next()?.to_string())
}

/// What's inside a modpack before installing it: every mod, the download size and the memory it needs.
pub fn preview(src: &PackSource) -> anyhow::Result<Value> {
    let (file, version) = source_file(src)?;
    // a dropped file: ask Modrinth which pack it is (for the icon); fine if it isn't one
    let idx = read_index(&file)?;
    let (loader, lv) = pack_loader(&idx.deps);
    let mods: Vec<&PackFile> = idx.files.iter().filter(|f| f.path.starts_with("mods")).collect();
    let pids: Vec<String> = mods.iter().filter_map(|f| modrinth_pid(&f.url)).collect::<HashSet<_>>().into_iter().collect();
    let projs = mods::projects(&pids).unwrap_or_default();
    let mut list: Vec<Value> = mods
        .iter()
        .map(|f| {
            let p = modrinth_pid(&f.url).and_then(|id| projs.get(&id));
            let file = f.path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            json!({
                "name": p.map(|p| str_of(p.get("title"))).filter(|s| !s.is_empty()).unwrap_or_else(|| file.trim_end_matches(".jar").replace(['-', '_'], " ")),
                "icon_url": p.and_then(|p| p.get("icon_url")).cloned(),
                "description": p.map(|p| str_of(p.get("description"))).unwrap_or_default(),
                "size": f.size,
            })
        })
        .collect();
    list.sort_by(|a, b| str_of(a.get("name")).to_lowercase().cmp(&str_of(b.get("name")).to_lowercase()));
    let overrides = zip_prefix_size(&file, &["overrides/", "client-overrides/"]);
    let pack_size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let download: u64 = idx.files.iter().map(|f| f.size).sum::<u64>() + pack_size;
    let need = memory_for(list.len());
    Ok(json!({
        "name": idx.name,
        "version_name": version.as_ref().map(|v| str_of(v.get("version_number"))).filter(|s| !s.is_empty()).unwrap_or(idx.version),
        "summary": idx.summary,
        "mc": idx.deps.get("minecraft").cloned().unwrap_or_default(),
        "loader": loader,
        "loader_version": lv,
        "mods": list,
        "other_files": idx.files.len() - mods.len(),
        "download_size": download,
        "unpacked_size": idx.files.iter().map(|f| f.size).sum::<u64>() + overrides,
        "memory_mb": need,
        "ram_mb": perf::total_ram_mb(),
        "project_id": version.as_ref().map(|v| str_of(v.get("project_id"))),
    }))
}

fn zip_prefix_size(path: &Path, prefixes: &[&str]) -> u64 {
    let Ok(f) = std::fs::File::open(path) else { return 0 };
    let Ok(mut z) = zip::ZipArchive::new(std::io::BufReader::new(f)) else { return 0 };
    let mut total = 0;
    for i in 0..z.len() {
        if let Ok(e) = z.by_index_raw(i) {
            if prefixes.iter().any(|p| e.name().starts_with(p)) {
                total += e.size();
            }
        }
    }
    total
}

fn download_checked(f: &PackFile, dest: &Path) -> anyhow::Result<()> {
    let bytes = get_bytes(&f.url)?;
    let ok = if !f.sha1.is_empty() { sha1_hex(&bytes) == f.sha1 } else if !f.sha512.is_empty() { sha512_hex(&bytes) == f.sha512 } else { true };
    if !ok {
        anyhow::bail!("{} didn't download correctly", f.path.display());
    }
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(dest, bytes)?;
    Ok(())
}

fn extract_overrides(path: &Path, mc: &Path) -> anyhow::Result<()> {
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(std::io::BufReader::new(f))?;
    for prefix in ["overrides/", "client-overrides/"] {
        for i in 0..z.len() {
            let mut e = z.by_index(i)?;
            let name = e.name().to_string();
            let Some(rest) = name.strip_prefix(prefix) else { continue };
            if rest.is_empty() || e.is_dir() {
                continue;
            }
            let Some(rel) = safe_rel(rest) else { continue };
            let dest = mc.join(rel);
            if let Some(d) = dest.parent() {
                std::fs::create_dir_all(d)?;
            }
            let mut out = std::fs::File::create(&dest)?;
            std::io::copy(&mut e, &mut out)?;
        }
    }
    Ok(())
}

/// Install a modpack as a brand-new instance. Packs are never updated afterwards.
pub fn install_pack(src: &PackSource, progress: Progress) -> anyhow::Result<String> {
    progress(0.02, "Getting the modpack");
    let (file, version) = source_file(src)?;
    let idx = read_index(&file)?;
    let mc = idx.deps.get("minecraft").cloned().filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("that modpack doesn't say which Minecraft it's for"))?;
    let (loader, lv) = pack_loader(&idx.deps);
    let (name, id) = free_name(if idx.name.trim().is_empty() { "Modpack" } else { idx.name.trim() });
    let dir = prism::instances_dir().join(&id);
    let mcd = dir.join("minecraft");
    std::fs::create_dir_all(&mcd)?;
    let result = (|| -> anyhow::Result<()> {
        // icon from the Modrinth project
        let mut icon = "default".to_string();
        if let Some(pid) = version.as_ref().map(|v| str_of(v.get("project_id"))).filter(|s| !s.is_empty()) {
            if let Ok(p) = get_json(&format!("{MR}/project/{pid}")) {
                if let Some(url) = p.get("icon_url").and_then(|u| u.as_str()) {
                    let ext = url.rsplit('.').next().unwrap_or("png").split('?').next().unwrap_or("png").to_string();
                    if let Ok(b) = get_bytes(url) {
                        icon = save_icon(&b, &format!("modrinth_{}", str_of(p.get("slug"))), &ext).unwrap_or(icon);
                    }
                }
            }
        }
        let mods = idx.files.iter().filter(|f| f.path.starts_with("mods")).count();
        let mem = memory_for(mods).min((perf::total_ram_mb() * 7 / 10).max(2048));
        write_cfg(&dir, &name, &icon, &[("OverrideMemory", "true".into()), ("MaxMemAlloc", mem.to_string()), ("MinMemAlloc", 1024.min(mem).to_string())])?;
        write_pack(&dir, &mc, &loader, &lv)?;
        let total: u64 = idx.files.iter().map(|f| f.size.max(1)).sum::<u64>().max(1);
        let done = AtomicU64::new(0);
        let count = AtomicUsize::new(0);
        let n = idx.files.len();
        let pool = rayon::ThreadPoolBuilder::new().num_threads(8).build()?;
        let errors: Vec<String> = pool.install(|| {
            use rayon::prelude::*;
            idx.files
                .par_iter()
                .filter_map(|f| {
                    let r = download_checked(f, &mcd.join(&f.path));
                    let d = done.fetch_add(f.size.max(1), Ordering::SeqCst) + f.size.max(1);
                    let c = count.fetch_add(1, Ordering::SeqCst) + 1;
                    progress(0.05 + 0.85 * (d as f32 / total as f32), &format!("Downloading {c} of {n}"));
                    r.err().map(|e| e.to_string())
                })
                .collect()
        });
        if !errors.is_empty() {
            anyhow::bail!("{} file{} didn't download: {}", errors.len(), if errors.len() == 1 { "" } else { "s" }, errors.into_iter().take(3).collect::<Vec<_>>().join("; "));
        }
        progress(0.93, "Unpacking the pack's settings");
        extract_overrides(&file, &mcd)?;
        progress(1.0, "Done");
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(id)
}

/// What kind of pack file this is: a Modrinth pack Mio installs, or one Prism has to import.
pub fn file_kind(path: &str) -> anyhow::Result<&'static str> {
    let f = std::fs::File::open(path)?;
    let z = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|_| anyhow::anyhow!("that file isn't a modpack"))?;
    let names: Vec<&str> = z.file_names().collect();
    if names.contains(&"modrinth.index.json") {
        Ok("modrinth")
    } else if names.contains(&"manifest.json") || names.iter().any(|n| n.ends_with("instance.cfg")) {
        Ok("prism")
    } else {
        anyhow::bail!("that zip isn't a modpack Mio knows")
    }
}

/// CurseForge packs and exported Prism instances: Prism's own importer handles those.
pub fn prism_import(path: &str) -> anyhow::Result<()> {
    let exe = prism::exe().ok_or_else(|| anyhow::anyhow!("Prism Launcher isn't installed where expected"))?;
    std::process::Command::new(exe).arg("--import").arg(path).spawn()?;
    Ok(())
}

// ------------------------------------------------------------------ export

fn downloads_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MIO_DOWNLOADS_DIR") {
        return PathBuf::from(d);
    }
    std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads")).unwrap_or_else(|_| data_dir())
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, base, out);
            } else if let Ok(rel) = p.strip_prefix(base) {
                out.push((p.clone(), rel.to_path_buf()));
            }
        }
    }
}

/// Save an instance as a .mrpack in Downloads. Mods on Modrinth are linked; everything else is packed in.
pub fn export(i: &prism::Instance, progress: Progress) -> anyhow::Result<PathBuf> {
    let mc = PathBuf::from(&i.mc_dir);
    progress(0.05, "Looking up your mods on Modrinth");
    let mut candidates: Vec<(PathBuf, String)> = vec![];
    for sub in ["mods", "resourcepacks", "shaderpacks"] {
        if let Ok(rd) = std::fs::read_dir(mc.join(sub)) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                let ok = if sub == "mods" { n.to_lowercase().ends_with(".jar") } else { n.to_lowercase().ends_with(".zip") };
                if ok && e.path().is_file() {
                    candidates.push((e.path(), format!("{sub}/{n}")));
                }
            }
        }
    }
    let hashed: Vec<(PathBuf, String, String, String, u64)> = {
        use rayon::prelude::*;
        candidates
            .par_iter()
            .map(|(p, rel)| {
                let b = std::fs::read(p).unwrap_or_default();
                (p.clone(), rel.clone(), sha1_hex(&b), sha512_hex(&b), b.len() as u64)
            })
            .collect()
    };
    let hashes: Vec<String> = hashed.iter().map(|h| h.2.clone()).collect();
    let found = if hashes.is_empty() { Value::Null } else { post_json(&format!("{MR}/version_files"), &json!({ "hashes": hashes, "algorithm": "sha1" })).unwrap_or(Value::Null) };
    let mut files = vec![];
    let mut packed: Vec<(PathBuf, PathBuf)> = vec![];
    for (p, rel, sha1, sha512, size) in &hashed {
        let url = found.get(sha1).and_then(|v| v.get("files")).and_then(|f| f.as_array()).and_then(|fs| fs.iter().find(|f| f.get("hashes").and_then(|h| h.get("sha1")).and_then(|s| s.as_str()) == Some(sha1.as_str()))).map(|f| str_of(f.get("url")));
        match url.filter(|u| !u.is_empty()) {
            Some(u) => files.push(json!({ "path": rel, "hashes": { "sha1": sha1, "sha512": sha512 }, "downloads": [u], "fileSize": size })),
            None => packed.push((p.clone(), PathBuf::from(rel))),
        }
    }
    walk(&mc.join("config"), &mc, &mut packed);
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".into(), json!(i.mc_version));
    match i.loader.as_str() {
        "fabric" => deps.insert("fabric-loader".into(), json!(i.loader_version)),
        "quilt" => deps.insert("quilt-loader".into(), json!(i.loader_version)),
        "neoforge" => deps.insert("neoforge".into(), json!(i.loader_version)),
        "forge" => deps.insert("forge".into(), json!(i.loader_version)),
        _ => None,
    };
    let index = json!({
        "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": i.name,
        "summary": format!("Exported from Mio Launcher ({} mods)", i.mods), "files": files, "dependencies": deps,
    });
    let base = clean_name(&if i.name.contains(&i.mc_version) { i.name.clone() } else { format!("{} {}", i.name, i.mc_version) });
    let out_dir = downloads_dir();
    let mut out = out_dir.join(format!("{base}.mrpack"));
    let mut n = 2;
    while out.exists() {
        out = out_dir.join(format!("{base} ({n}).mrpack"));
        n += 1;
    }
    progress(0.4, "Packing it up");
    let tmp = out.with_extension("mrpack.part");
    {
        let mut z = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("modrinth.index.json", opts)?;
        z.write_all(&serde_json::to_vec_pretty(&index)?)?;
        let total = packed.len().max(1);
        for (k, (src, rel)) in packed.iter().enumerate() {
            let name = format!("overrides/{}", rel.to_string_lossy().replace('\\', "/"));
            z.start_file(name, opts)?;
            z.write_all(&std::fs::read(src)?)?;
            if k % 20 == 0 {
                progress(0.4 + 0.58 * (k as f32 / total as f32), "Packing it up");
            }
        }
        z.finish()?;
    }
    std::fs::rename(&tmp, &out)?;
    progress(1.0, "Done");
    Ok(out)
}

// ------------------------------------------------------------------ manage

fn dir_size(p: &Path, skip: &dyn Fn(&Path) -> bool) -> u64 {
    if skip(p) {
        return 0;
    }
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path(), skip)).sum()).unwrap_or(0)
}

fn copy_tree(from: &Path, to: &Path, skip: &dyn Fn(&Path) -> bool, done: &AtomicU64, total: u64, progress: Progress) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let p = e.path();
        if skip(&p) {
            continue;
        }
        let dest = to.join(e.file_name());
        if p.is_dir() {
            copy_tree(&p, &dest, skip, done, total, progress)?;
        } else {
            let n = std::fs::copy(&p, &dest)?;
            let d = done.fetch_add(n, Ordering::SeqCst) + n;
            progress(0.02 + 0.9 * (d as f32 / total.max(1) as f32), "Copying");
        }
    }
    Ok(())
}

/// Copy an instance (with or without its worlds). Returns the new instance's id.
pub fn duplicate(i: &prism::Instance, name: &str, with_worlds: bool, progress: Progress) -> anyhow::Result<String> {
    let src = PathBuf::from(&i.dir);
    let saves = PathBuf::from(&i.mc_dir).join("saves");
    let skip = |p: &Path| (!with_worlds && p == saves.as_path()) || p.file_name().map(|n| n == "logs" || n == "crash-reports").unwrap_or(false) && p.parent() == Some(Path::new(&i.mc_dir));
    let total = dir_size(&src, &skip);
    let free = fs_free_bytes(&prism::instances_dir());
    if free > 0 && total + (512 << 20) > free {
        anyhow::bail!("Not enough free space: the copy needs {} MB", total >> 20);
    }
    let id = unique_id(name);
    let dest = prism::instances_dir().join(&id);
    let done = AtomicU64::new(0);
    if let Err(e) = copy_tree(&src, &dest, &skip, &done, total, progress) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    let cfg = dest.join("instance.cfg");
    prism::write_cfg_keys(&cfg, &[("name", name.trim().to_string()), ("uuid", new_uuid(name)), ("totalTimePlayed", "0".into()), ("lastTimePlayed", "0".into()), ("lastLaunchTime", "0".into())])?;
    let prof = data_dir().join("profiles");
    let _ = std::fs::copy(prof.join(format!("{}.json", i.id)), prof.join(format!("{id}.json")));
    progress(1.0, "Done");
    Ok(id)
}

#[cfg(windows)]
fn fs_free_bytes(p: &Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut a, mut t, mut f) = (0u64, 0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut a, &mut t, &mut f) } != 0 { a } else { 0 }
}
#[cfg(not(windows))]
fn fs_free_bytes(_p: &Path) -> u64 {
    0
}

pub fn rename(i: &prism::Instance, name: &str) -> anyhow::Result<()> {
    let n = name.trim();
    if n.is_empty() || n.contains('\n') {
        anyhow::bail!("give it a name");
    }
    prism::write_cfg_keys(&PathBuf::from(&i.dir).join("instance.cfg"), &[("name", n.chars().take(80).collect())])
}

/// Move a whole instance to the Recycle Bin.
pub fn delete(i: &prism::Instance) -> anyhow::Result<()> {
    // Only ever a folder directly inside Prism's instances folder.
    let dir = PathBuf::from(&i.dir);
    let root = prism::instances_dir();
    let ok = match (dir.canonicalize(), root.canonicalize()) {
        (Ok(d), Ok(r)) => d.parent() == Some(r.as_path()) && d.join("instance.cfg").is_file(),
        _ => false,
    };
    if !ok {
        anyhow::bail!("that folder isn't a Prism instance, so Mio won't delete it");
    }
    trash::delete(&dir).map_err(|e| anyhow::anyhow!("couldn't move it to the Recycle Bin: {e}"))?;
    let _ = std::fs::remove_file(data_dir().join("profiles").join(format!("{}.json", i.id)));
    Ok(())
}

pub fn set_icon(i: &prism::Instance, key: &str) -> anyhow::Result<()> {
    prism::write_cfg_keys(&PathBuf::from(&i.dir).join("instance.cfg"), &[("iconKey", key.to_string())])
}

// ------------------------------------------------------------------ Java

#[derive(Serialize, Clone)]
pub struct Java {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub vendor: String,
}

fn java_in(home: &Path) -> Option<Java> {
    let exe = home.join("bin").join("javaw.exe");
    if !exe.is_file() {
        return None;
    }
    let rel = std::fs::read_to_string(home.join("release")).unwrap_or_default();
    let field = |k: &str| rel.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(|v| v.trim_matches('"').to_string()).unwrap_or_default();
    let version = field("JAVA_VERSION");
    let major = version.split('.').next().and_then(|m| m.parse::<u32>().ok()).map(|m| if m == 1 { version.split('.').nth(1).and_then(|x| x.parse().ok()).unwrap_or(8) } else { m }).unwrap_or(0);
    Some(Java { path: exe.to_string_lossy().replace('\\', "/"), version, major, vendor: field("IMPLEMENTOR") })
}

/// Java installs on this PC: Prism's own downloads, plus the usual install folders.
pub fn javas() -> Vec<Java> {
    let mut roots: Vec<PathBuf> = vec![prism::data_dir().join("java")];
    for pf in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(p) = std::env::var(pf) {
            for v in ["Java", "Eclipse Adoptium", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto", "Semeru"] {
                roots.push(PathBuf::from(&p).join(v));
            }
        }
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        roots.push(PathBuf::from(h).join(".jdks"));
    }
    let mut out: Vec<Java> = vec![];
    let mut seen = HashSet::new();
    for r in roots {
        for e in std::fs::read_dir(&r).map(|rd| rd.flatten().collect::<Vec<_>>()).unwrap_or_default() {
            for home in [e.path(), e.path().join("windows-x64").join(e.file_name())] {
                if let Some(j) = java_in(&home) {
                    if seen.insert(j.path.to_lowercase()) {
                        out.push(j);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.major.cmp(&a.major).then(a.path.cmp(&b.path)));
    out
}

/// The Java a Minecraft version wants.
pub fn java_needed(mc: &str) -> u32 {
    let parts: Vec<u32> = mc.split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse().ok()).collect();
    match parts.as_slice() {
        [y, ..] if *y >= 26 => 25,
        [1, m, p, ..] if *m > 20 || (*m == 20 && *p >= 5) => 21,
        [1, m, ..] if *m > 20 => 21,
        [1, m, ..] if *m >= 18 => 17,
        [1, 17, ..] => 16,
        _ => 8,
    }
}

pub fn settings(i: &prism::Instance) -> Value {
    let cfg = prism::read_cfg(&PathBuf::from(&i.dir).join("instance.cfg"));
    let over = cfg.get("OverrideJavaLocation").map(|v| v == "true").unwrap_or(false);
    json!({
        "max_mem": i.max_mem,
        "ram_mb": perf::total_ram_mb(),
        "java_path": if over { cfg.get("JavaPath").cloned() } else { None },
        "java_version": cfg.get("JavaVersion").cloned(),
        "java_needed": java_needed(&i.mc_version),
        "javas": javas(),
    })
}

pub fn set_java(i: &prism::Instance, path: Option<String>) -> anyhow::Result<()> {
    let cfg = PathBuf::from(&i.dir).join("instance.cfg");
    match path.filter(|p| !p.is_empty()) {
        None => prism::write_cfg_keys(&cfg, &[("OverrideJavaLocation", "false".into()), ("AutomaticJava", "true".into())]),
        Some(p) => {
            if !Path::new(&p).is_file() || !p.to_lowercase().ends_with("java.exe") && !p.to_lowercase().ends_with("javaw.exe") {
                anyhow::bail!("that isn't a Java program");
            }
            prism::write_cfg_keys(&cfg, &[("OverrideJavaLocation", "true".into()), ("AutomaticJava", "false".into()), ("JavaPath", p.replace('\\', "/"))])
        }
    }
}

// ------------------------------------------------------------------ upgrade

fn release_time(mc: &str) -> String {
    versions_of("net.minecraft").iter().find(|v| str_of(v.get("version")) == mc).map(|v| str_of(v.get("releaseTime"))).unwrap_or_default()
}

/// Newer full releases an instance could move to.
pub fn upgrade_targets(i: &prism::Instance) -> Vec<String> {
    let cur = release_time(&i.mc_version);
    versions_of("net.minecraft").iter().filter(|v| str_of(v.get("type")) == "release" && str_of(v.get("releaseTime")) > cur).map(|v| str_of(v.get("version"))).collect()
}

fn target_loader(i: &prism::Instance, target: &str) -> Option<String> {
    match i.loader.as_str() {
        "fabric" | "quilt" => fabric_supports(target).then(|| if i.loader == "fabric" { fabric_version().unwrap_or_else(|| i.loader_version.clone()) } else { i.loader_version.clone() }),
        "neoforge" => neoforge_for(target),
        "vanilla" => Some(String::new()),
        _ => None,
    }
}

/// Which mods already have a version for `target`, and which don't.
pub fn upgrade_check(i: &prism::Instance, target: &str) -> anyhow::Result<Value> {
    let mc = PathBuf::from(&i.mc_dir);
    let lv = target_loader(i, target);
    mods::identify(&mc, false).ok();
    let list: Vec<mods::InstalledMod> = mods::installed(&mc).into_iter().filter(|m| m.enabled).collect();
    let hashes: Vec<String> = list.iter().filter(|m| m.modrinth.is_some()).map(|m| m.sha1.clone()).collect();
    let loaders = if i.loader == "quilt" { json!(["quilt", "fabric"]) } else { json!([i.loader]) };
    let res = if hashes.is_empty() { Value::Null } else { post_json(&format!("{MR}/version_files/update"), &json!({ "hashes": hashes, "algorithm": "sha1", "loaders": loaders, "game_versions": [target] }))? };
    let mut ready = vec![];
    let mut not_ready = vec![];
    for m in &list {
        let name = m.modrinth.as_ref().map(|r| r.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| m.meta.name.clone());
        let icon = m.modrinth.as_ref().and_then(|r| r.icon_url.clone());
        match res.get(&m.sha1).filter(|v| v.get("game_versions").and_then(|g| g.as_array()).map(|g| g.iter().any(|x| x.as_str() == Some(target))).unwrap_or(false)) {
            Some(v) => ready.push(json!({ "file": m.file, "name": name, "icon_url": icon, "to": str_of(v.get("version_number")), "version_id": str_of(v.get("id")) })),
            None => not_ready.push(json!({ "file": m.file, "name": name, "icon_url": icon, "why": if m.modrinth.is_some() { "No version for this yet" } else { "Not on Modrinth, so Mio can't check" } })),
        }
    }
    let by_name = |a: &Value, b: &Value| str_of(a.get("name")).to_lowercase().cmp(&str_of(b.get("name")).to_lowercase());
    ready.sort_by(by_name);
    not_ready.sort_by(by_name);
    Ok(json!({ "target": target, "loader_ok": lv.is_some(), "loader_version": lv, "ready": ready, "not_ready": not_ready }))
}

/// Make an upgraded copy: same settings and (optionally) worlds, mods moved to `target`'s versions,
/// and mods that aren't ready yet turned off. The original isn't touched.
pub fn upgrade(i: &prism::Instance, target: &str, with_worlds: bool, progress: Progress) -> anyhow::Result<String> {
    let check = upgrade_check(i, target)?;
    let lv = check.get("loader_version").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or_else(|| anyhow::anyhow!("{} isn't out for {target} yet", store::loader_label(&i.loader)))?;
    // "Survival 26.2" becomes "Survival 26.3"; other names get the version added.
    let swapped = if !i.mc_version.is_empty() && i.name.contains(&i.mc_version) { Some(i.name.replacen(&i.mc_version, target, 1)) } else { None };
    let taken = |n: &str| prism::instances().iter().any(|x| x.name.eq_ignore_ascii_case(n));
    let name = match swapped {
        Some(n) if !taken(&n) => n,
        _ => format!("{} {target}", i.name),
    };
    let copy_progress = |p: f32, l: &str| progress(p * 0.6, l);
    let id = duplicate(i, &name, with_worlds, &copy_progress)?;
    let dir = prism::instances_dir().join(&id);
    write_pack(&dir, target, &i.loader, &lv)?;
    let mods_dir = prism::mc_dir_of(&dir).join("mods");
    let ready: Vec<Value> = check.get("ready").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let n = ready.len().max(1);
    for (k, m) in ready.iter().enumerate() {
        progress(0.6 + 0.35 * (k as f32 / n as f32), "Updating mods for the new version");
        let file = str_of(m.get("file"));
        let vid = str_of(m.get("version_id"));
        let r = (|| -> anyhow::Result<()> {
            let v = get_json(&format!("{MR}/version/{vid}"))?;
            let new = store::download_into(&mods_dir, &v, &[".jar"])?;
            if new != file {
                let _ = std::fs::remove_file(mods_dir.join(&file));
            }
            Ok(())
        })();
        if r.is_err() {
            let _ = std::fs::rename(mods_dir.join(&file), mods_dir.join(format!("{file}.disabled")));
        }
    }
    for m in check.get("not_ready").and_then(|r| r.as_array()).cloned().unwrap_or_default() {
        let file = str_of(m.get("file"));
        if !file.is_empty() && mods_dir.join(&file).is_file() {
            let _ = std::fs::rename(mods_dir.join(&file), mods_dir.join(format!("{file}.disabled")));
        }
    }
    progress(1.0, "Done");
    Ok(id)
}

pub fn version_list(i: &prism::Instance) -> Value {
    json!({ "targets": upgrade_targets(i) })
}

