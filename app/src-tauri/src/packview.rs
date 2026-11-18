//! Resource pack preview: the block textures the 3D world uses, swapped for a pack's.
//!
//! The 3D world packs every block texture it needs into one texture array (16x16 layers,
//! allocated as chunks are meshed). For a preview we build a second array with the same
//! layers, at the pack's own resolution, where every texture the pack changes is the pack's
//! version and everything else is vanilla (scaled up, pixel for pixel). The page samples one
//! array or the other per pixel, which is how the split compare works.
//! Nothing is ever written: packs are only read.

use crate::launcher::{prism, sync};
use crate::{AppState, R, err};
use image::RgbaImage;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use tauri::State;

// ---------------------------------------------------------------- reading a pack

pub struct Pack {
    path: PathBuf,
    zip: Option<Mutex<zip::ZipArchive<std::fs::File>>>,
    /// every file in the pack (zip) — empty for folders
    files: HashSet<String>,
    /// "" plus the overlay folders that apply to this version, highest priority first
    roots: Vec<String>,
    pub meta: Value,
}

impl Pack {
    pub fn open(path: &Path, target: Option<(u32, u32)>) -> Option<Pack> {
        let (zip, files) = if path.is_dir() {
            (None, HashSet::new())
        } else {
            let z = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
            let files: HashSet<String> = z.file_names().map(|s| s.to_string()).collect();
            (Some(Mutex::new(z)), files)
        };
        let mut p = Pack { path: path.to_path_buf(), zip, files, roots: vec![String::new()], meta: Value::Null };
        let meta: Value = p.raw("pack.mcmeta").and_then(|b| serde_json::from_str(String::from_utf8_lossy(&b).trim_start_matches('\u{feff}')).ok()).unwrap_or(Value::Null);
        // overlays: later entries win
        let mut over = vec![];
        if let Some(es) = meta["overlays"]["entries"].as_array() {
            for e in es {
                let Some(dir) = e["directory"].as_str() else { continue };
                let mut m = serde_json::json!({ "pack": {} });
                if !e["formats"].is_null() {
                    m["pack"]["supported_formats"] = e["formats"].clone();
                }
                for k in ["min_format", "max_format"] {
                    if !e[k].is_null() {
                        m["pack"][k] = e[k].clone();
                    }
                }
                if sync::compat(sync::pack_range(&m), target) == Some(true) {
                    over.push(format!("{}/", dir.trim_matches('/')));
                }
            }
        }
        over.reverse();
        over.push(String::new());
        p.roots = over;
        p.meta = meta;
        Some(p)
    }

    fn raw(&self, name: &str) -> Option<Vec<u8>> {
        match &self.zip {
            Some(z) => {
                if !self.files.contains(name) {
                    return None;
                }
                let mut z = z.lock();
                let mut e = z.by_name(name).ok()?;
                let mut b = Vec::with_capacity(e.size() as usize);
                e.read_to_end(&mut b).ok()?;
                Some(b)
            }
            None => std::fs::read(self.path.join(name)).ok(),
        }
    }

    /// A file under assets/minecraft/, overlays first.
    pub fn get(&self, rel: &str) -> Option<Vec<u8>> {
        self.roots.iter().find_map(|r| self.raw(&format!("{r}assets/minecraft/{rel}")))
    }

    fn has(&self, rel: &str) -> bool {
        match &self.zip {
            Some(_) => self.roots.iter().any(|r| self.files.contains(&format!("{r}assets/minecraft/{rel}"))),
            None => self.roots.iter().any(|r| self.path.join(format!("{r}assets/minecraft/{rel}")).is_file()),
        }
    }

    /// How many files the pack has under assets/minecraft/<prefix>.
    fn count(&self, prefix: &str, ext: &str) -> usize {
        let mut seen = HashSet::new();
        match &self.zip {
            Some(_) => {
                for r in &self.roots {
                    let p = format!("{r}assets/minecraft/{prefix}");
                    for f in self.files.iter().filter(|f| f.starts_with(&p) && f.ends_with(ext)) {
                        seen.insert(f[r.len()..].to_string());
                    }
                }
            }
            None => {
                for r in &self.roots {
                    let base = self.path.join(format!("{r}assets/minecraft/{prefix}"));
                    walk(&base, &mut |p| {
                        if p.to_string_lossy().ends_with(ext) {
                            seen.insert(p.strip_prefix(&base).map(|x| x.to_string_lossy().to_string()).unwrap_or_default());
                        }
                    });
                }
            }
        }
        seen.len()
    }

    fn any_prefix(&self, prefixes: &[&str]) -> bool {
        match &self.zip {
            Some(_) => self.files.iter().any(|f| prefixes.iter().any(|p| f.contains(p))),
            None => prefixes.iter().any(|p| self.path.join(p.trim_start_matches('/')).exists()),
        }
    }
}

fn walk(dir: &Path, f: &mut dyn FnMut(&Path)) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, f);
        } else {
            f(&p);
        }
    }
}

/// The frames of an (animated) texture, in play order, at the pack's own size.
fn frames_of(png: &[u8], meta: Option<&[u8]>) -> Option<Vec<RgbaImage>> {
    let img = image::load_from_memory(png).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let meta: Option<Value> = meta.and_then(|m| serde_json::from_slice(m).ok());
    let anim = meta.as_ref().map(|m| &m["animation"]).filter(|a| !a.is_null());
    let fw = anim.and_then(|a| a["width"].as_u64()).map(|v| v as u32).unwrap_or(w.min(h));
    let fh = anim.and_then(|a| a["height"].as_u64()).map(|v| v as u32).unwrap_or(w.min(h));
    let (fw, fh) = if anim.is_some() && fw > 0 && fh > 0 && w % fw == 0 && h % fh == 0 { (fw, fh) } else { (w, if h > w && h % w == 0 { w } else { h }) };
    let cols = (w / fw).max(1);
    let n = cols * (h / fh).max(1);
    let order: Vec<u32> = anim
        .and_then(|a| a["frames"].as_array())
        .map(|fr| fr.iter().filter_map(|e| e.as_u64().or_else(|| e["index"].as_u64()).map(|v| v as u32)).collect::<Vec<_>>())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| (0..n).collect());
    let out: Vec<RgbaImage> = order
        .into_iter()
        .filter(|f| *f < n)
        .take(48)
        .map(|f| image::imageops::crop_imm(&img, (f % cols) * fw, (f / cols) * fh, fw, fh).to_image())
        .collect();
    if out.is_empty() { None } else { Some(out) }
}

// ---------------------------------------------------------------- the preview session

struct Session {
    key: String,
    pack: Arc<Pack>,
    res: u32,
    /// decoded textures by name ("block/stone"); None = the pack doesn't change it
    cache: HashMap<String, Option<Arc<Vec<RgbaImage>>>>,
    /// vanilla image sizes (for cutting entity textures)
    vsize: HashMap<String, (u32, u32)>,
    changed: usize,
}

static SESSION: LazyLock<Mutex<Option<Session>>> = LazyLock::new(|| Mutex::new(None));

fn safe(s: &str) -> bool {
    !s.is_empty() && !s.contains("..") && !s.contains('/') && !s.contains('\\') && !s.contains(':')
}

/// The pack file inside an instance's resourcepacks folder.
fn pack_path(inst: &str, file: &str) -> Option<PathBuf> {
    if !prism::safe_id(inst) || !safe(file) {
        return None;
    }
    let p = prism::mc_dir_of(&prism::instances_dir().join(inst)).join("resourcepacks").join(file);
    p.exists().then_some(p)
}

fn tex_of<'a>(s: &'a mut Session, name: &str) -> Option<Arc<Vec<RgbaImage>>> {
    if let Some(c) = s.cache.get(name) {
        return c.clone();
    }
    let rel = format!("textures/{name}.png");
    let v = s.pack.get(&rel).and_then(|png| frames_of(&png, s.pack.get(&format!("{rel}.mcmeta")).as_deref())).map(Arc::new);
    s.cache.insert(name.to_string(), v.clone());
    v
}

fn scale_to(img: &RgbaImage, res: u32) -> RgbaImage {
    if img.width() == res && img.height() == res {
        img.clone()
    } else {
        image::imageops::resize(img, res, res, image::imageops::FilterType::Nearest)
    }
}

/// One layer of the preview array.
fn layer(s: &mut Session, assets: &mcassets::Assets, name: &str, frame: u16, vanilla: &[u8]) -> Vec<u8> {
    let res = s.res;
    let (tex, rect) = match name.split_once('#') {
        Some((t, r)) => {
            let v: Vec<u32> = r.split(',').filter_map(|x| x.parse().ok()).collect();
            (t, (v.len() == 4).then(|| (v[0], v[1], v[2], v[3])))
        }
        None => (name, None),
    };
    if tex != "missing" {
        if let Some(frames) = tex_of(s, tex) {
            let f = &frames[frame as usize % frames.len()];
            let tile = match rect {
                None => Some(scale_to(f, res)),
                Some((x, y, w, h)) => {
                    // entity textures: cut the same part out of the pack's (maybe bigger) image
                    let vs = *s.vsize.entry(tex.to_string()).or_insert_with(|| {
                        assets.jar.get(&format!("textures/{tex}.png")).and_then(|b| image::load_from_memory(b).ok()).map(|i| (i.width(), i.height())).unwrap_or((64, 64))
                    });
                    let (sx, sy) = (f.width() as f32 / vs.0.max(1) as f32, f.height() as f32 / vs.1.max(1) as f32);
                    let (cx, cy) = ((x as f32 * sx) as u32, (y as f32 * sy) as u32);
                    let (cw, ch) = (((w as f32 * sx) as u32).max(1), ((h as f32 * sy) as u32).max(1));
                    (cx + cw <= f.width() && cy + ch <= f.height()).then(|| scale_to(&image::imageops::crop_imm(f, cx, cy, cw, ch).to_image(), res))
                }
            };
            if let Some(t) = tile {
                return t.into_raw();
            }
        }
    }
    // vanilla, scaled up pixel for pixel
    let k = res / 16;
    let mut out = vec![0u8; (res * res * 4) as usize];
    for y in 0..res {
        for x in 0..res {
            let (vx, vy) = ((x / k).min(15), (y / k).min(15));
            let si = ((vy * 16 + vx) * 4) as usize;
            let di = ((y * res + x) * 4) as usize;
            out[di..di + 4].copy_from_slice(&vanilla[si..si + 4]);
        }
    }
    out
}

/// The pack's own texture size: the biggest of a handful of common block textures.
fn native_res(pack: &Pack) -> u32 {
    let mut best = 16u32;
    for t in ["stone", "dirt", "oak_planks", "cobblestone", "grass_block_side", "oak_log", "stone_bricks", "sand", "glass", "deepslate"] {
        if let Some(b) = pack.get(&format!("textures/block/{t}.png")) {
            if let Ok(d) = image::ImageReader::new(std::io::Cursor::new(&b)).with_guessed_format().map(|r| r.into_dimensions()) {
                if let Ok((w, _)) = d {
                    best = best.max(w);
                }
            }
        }
    }
    best
}

/// The size the preview uses: a power of two, at most 128, and the whole array under ~200 MB.
fn pick_res(pack: &Pack, layers: usize) -> u32 {
    let mut r = native_res(pack).next_power_of_two().clamp(16, 128);
    while r > 16 && (layers.max(1) as u64) * (r as u64) * (r as u64) * 4 > 200 * 1024 * 1024 {
        r /= 2;
    }
    r
}

fn open_session(inst: &str, file: &str, assets: &mcassets::Assets) -> anyhow::Result<()> {
    let key = format!("{inst}/{file}");
    let mut g = SESSION.lock();
    if g.as_ref().map(|s| s.key == key).unwrap_or(false) {
        return Ok(());
    }
    let path = pack_path(inst, file).ok_or_else(|| anyhow::anyhow!("That pack isn't there any more"))?;
    let target = sync::version_format(&assets.version);
    let pack = Pack::open(&path, target).ok_or_else(|| anyhow::anyhow!("Couldn't read that pack"))?;
    let res = pick_res(&pack, assets.tex.layer_count() as usize + 512);
    *g = Some(Session { key, pack: Arc::new(pack), res, cache: HashMap::new(), vsize: HashMap::new(), changed: 0 });
    Ok(())
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct PackInfo {
    inst: String,
    inst_name: String,
    file: String,
    name: String,
    desc: String,
    res: u32,
    /// the size the preview shows it at (big packs are scaled down to fit)
    shown: u32,
    /// made for this Minecraft version (None: the pack doesn't say)
    ok: Option<bool>,
    /// turned on in that instance
    on: bool,
    blocks: usize,
    items: usize,
    gui: usize,
    entity: usize,
    sky: usize,
    models: usize,
    ctm: bool,
}

/// Text of a description that may be a text component.
fn flat_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(flat_text).collect(),
        Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(e) = o.get("extra") {
                s.push_str(&flat_text(e));
            }
            s
        }
        _ => String::new(),
    }
}

fn strip_codes(s: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for c in s.chars() {
        if skip {
            skip = false;
            continue;
        }
        if c == '\u{a7}' {
            skip = true;
            continue;
        }
        out.push(c);
    }
    out
}

/// The resource packs in your instances (LongTerm first), with what each one changes.
#[tauri::command]
pub async fn pack_list(state: State<'_, AppState>) -> R<Vec<PackInfo>> {
    let assets = state.assets()?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = sync::version_format(&assets.version);
        let mut out: Vec<PackInfo> = vec![];
        let mut seen = HashSet::new();
        let mut insts = prism::instances();
        insts.sort_by_key(|i| (i.name != "LongTerm", i.mc_version != assets.version, i.name.to_lowercase()));
        for i in insts {
            let start = out.len();
            let mc = PathBuf::from(&i.mc_dir);
            let opts = std::fs::read_to_string(mc.join("options.txt")).unwrap_or_default();
            let on_list: Vec<String> = opts.lines().find_map(|l| l.strip_prefix("resourcePacks:")).and_then(|v| serde_json::from_str(v).ok()).unwrap_or_default();
            let Ok(rd) = std::fs::read_dir(mc.join("resourcepacks")) else { continue };
            for e in rd.flatten() {
                let file = e.file_name().to_string_lossy().to_string();
                let p = e.path();
                if !(p.is_dir() && p.join("pack.mcmeta").exists() || file.to_lowercase().ends_with(".zip")) || !seen.insert(file.to_lowercase()) {
                    continue;
                }
                let Some(pack) = Pack::open(&p, target) else { continue };
                let name = strip_codes(file.trim_end_matches(".zip").trim_end_matches(".ZIP")).trim().to_string();
                let native = native_res(&pack);
                let shown = pick_res(&pack, assets.tex.layer_count() as usize + 512);
                let desc = strip_codes(&flat_text(&pack.meta["pack"]["description"]));
                out.push(PackInfo {
                    inst: i.id.clone(),
                    inst_name: i.name.clone(),
                    on: on_list.iter().any(|x| x == &format!("file/{file}")),
                    res: native,
                    shown,
                    ok: sync::compat(sync::pack_range(&pack.meta), target),
                    blocks: pack.count("textures/block/", ".png"),
                    items: pack.count("textures/item/", ".png"),
                    gui: pack.count("textures/gui/", ".png"),
                    entity: pack.count("textures/entity/", ".png"),
                    sky: pack.count("textures/environment/", ".png"),
                    models: pack.count("models/", ".json"),
                    ctm: pack.any_prefix(&["/optifine/ctm/", "/continuity", "/optifine/emissive"]),
                    file,
                    name,
                    desc,
                });
            }
            // packs that change blocks first: those are the ones that show on the base
            out[start..].sort_by_key(|p| (p.blocks == 0, !p.on, p.name.to_lowercase()));
        }
        out
    })
    .await
    .map_err(err)
}

/// Layers `from..` of the preview array for a pack: [res u32][total u32][from u32][changed u32] + RGBA.
#[tauri::command]
pub async fn pack_tex(state: State<'_, AppState>, inst: String, file: String, from: u32) -> R<tauri::ipc::Response> {
    let assets = state.assets()?;
    let out = tauri::async_runtime::spawn_blocking(move || -> R<Vec<u8>> {
        open_session(&inst, &file, &assets).map_err(err)?;
        let names = assets.tex.layer_names();
        let vanilla = assets.tex.rgba();
        let mut g = SESSION.lock();
        let s = g.as_mut().ok_or("no pack")?;
        let total = names.len() as u32;
        let from = from.min(total);
        let res = s.res;
        let mut body = Vec::with_capacity(16 + ((total - from) * res * res * 4) as usize);
        let mut changed = 0u32;
        let mut rgba = Vec::with_capacity(((total - from) * res * res * 4) as usize);
        for i in from..total {
            let (name, frame) = &names[i as usize];
            let v = &vanilla[i as usize * 1024..i as usize * 1024 + 1024];
            let base = name.split('#').next().unwrap_or(name);
            if base != "missing" && tex_of(s, base).is_some() {
                changed += 1;
            }
            rgba.extend_from_slice(&layer(s, &assets, name, *frame, v));
        }
        s.changed = if from == 0 { changed as usize } else { s.changed + changed as usize };
        body.extend_from_slice(&res.to_le_bytes());
        body.extend_from_slice(&total.to_le_bytes());
        body.extend_from_slice(&from.to_le_bytes());
        body.extend_from_slice(&(s.changed as u32).to_le_bytes());
        body.extend_from_slice(&rgba);
        Ok(body)
    })
    .await
    .map_err(err)??;
    Ok(tauri::ipc::Response::new(out))
}

/// Forget the open pack (frees its decoded textures).
#[tauri::command]
pub fn pack_close() {
    *SESSION.lock() = None;
}

/// Which of these textures (e.g. "item/diamond_sword", "gui/sprites/hud/hotbar") a pack changes.
#[tauri::command]
pub async fn pack_has(inst: String, file: String, names: Vec<String>) -> R<Vec<bool>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = pack_path(&inst, &file).ok_or("That pack isn't there any more")?;
        let target = sync::version_format("26.3");
        let pack = Pack::open(&path, target).ok_or("Couldn't read that pack")?;
        Ok(names.iter().map(|n| pack.has(&format!("textures/{n}.png"))).collect())
    })
    .await
    .map_err(err)?
}

/// First frame of an image (animated textures are tall strips).
fn first_frame(png: Vec<u8>) -> Vec<u8> {
    let Ok(img) = image::load_from_memory(&png) else { return png };
    let (w, h) = (img.width(), img.height());
    if h > w && h % w == 0 && w > 0 {
        let f = img.crop_imm(0, 0, w, w).to_rgba8();
        return crate::tiles::png_bytes(&f);
    }
    png
}

/// `packimg/<inst>/<file>/<texture path>`: a texture from a pack (404 when the pack doesn't change it).
pub fn proto_pack(inst: &str, file: &str, rel: &str) -> Option<Vec<u8>> {
    if rel.contains("..") {
        return None;
    }
    let path = pack_path(inst, file)?;
    let pack = {
        let g = SESSION.lock();
        g.as_ref().filter(|s| s.key == format!("{inst}/{file}")).map(|s| s.pack.clone())
    };
    let pack = match pack {
        Some(p) => p,
        None => Arc::new(Pack::open(&path, sync::version_format("26.3"))?),
    };
    pack.get(&format!("textures/{rel}")).map(first_frame)
}

/// `vanillaimg/<texture path>`: the same texture from the game itself.
pub fn proto_vanilla(assets: &mcassets::Assets, rel: &str) -> Option<Vec<u8>> {
    if rel.contains("..") {
        return None;
    }
    assets.jar.get(&format!("textures/{rel}")).map(|b| first_frame(b.to_vec()))
}
