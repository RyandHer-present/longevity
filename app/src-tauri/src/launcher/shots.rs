//! Screenshots from every instance, with cached thumbnails.

use super::prism;
use super::util::*;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct Shot {
    pub key: String,
    pub instance: String,
    pub instance_name: String,
    pub file: String,
    pub time: i64,
    pub size: u64,
}

/// "2026-11-11_21.21.38.png" -> unix ms in local time (approximated with the file's own clock).
fn time_of(p: &Path) -> i64 {
    mtime_ms(p)
}

pub fn list() -> Vec<Shot> {
    let mut out = vec![];
    for inst in prism::instances() {
        let dir = PathBuf::from(&inst.mc_dir).join("screenshots");
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let n = e.file_name().to_string_lossy().to_string();
                let lower = n.to_lowercase();
                if !(lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")) {
                    continue;
                }
                out.push(Shot {
                    key: format!("{}/{}", inst.id, n),
                    instance: inst.id.clone(),
                    instance_name: inst.name.clone(),
                    file: n,
                    time: time_of(&p),
                    size: e.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

pub fn resolve(key: &str) -> Option<PathBuf> {
    let (inst, file) = key.split_once('/')?;
    if !prism::safe_id(inst) || file.contains('/') || file.contains('\\') || file.contains("..") {
        return None;
    }
    let p = prism::mc_dir_of(&prism::instances_dir().join(inst)).join("screenshots").join(file);
    p.is_file().then_some(p)
}

pub fn thumb(key: &str, width: u32) -> Option<Vec<u8>> {
    let p = resolve(key)?;
    let cache = data_dir().join("cache").join("thumbs");
    let _ = std::fs::create_dir_all(&cache);
    let name = format!("{:016x}-{}-{width}.jpg", fnv(key), mtime_ms(&p));
    let cp = cache.join(&name);
    if let Ok(b) = std::fs::read(&cp) {
        return Some(b);
    }
    let img = image::open(&p).ok()?;
    let t = img.thumbnail(width, width * 2);
    let mut buf = std::io::Cursor::new(Vec::new());
    t.to_rgb8().write_to(&mut buf, image::ImageFormat::Jpeg).ok()?;
    let b = buf.into_inner();
    let _ = std::fs::write(&cp, &b);
    Some(b)
}

pub fn copy_to_clipboard(key: &str) -> anyhow::Result<()> {
    let p = resolve(key).ok_or_else(|| anyhow::anyhow!("screenshot not found"))?;
    let img = image::open(p)?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut cb = arboard::Clipboard::new()?;
    cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(img.into_raw()) })?;
    Ok(())
}

/// Copy an edited picture (PNG bytes) to the clipboard.
pub fn copy_png(png: &[u8]) -> anyhow::Result<()> {
    let img = image::load_from_memory(png)?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut cb = arboard::Clipboard::new()?;
    cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Owned(img.into_raw()) })?;
    Ok(())
}

/// Save an edited copy next to the original ("<name>_edit.png"); returns its key. The original is untouched.
pub fn save_edit(key: &str, png: &[u8]) -> anyhow::Result<String> {
    let p = resolve(key).ok_or_else(|| anyhow::anyhow!("screenshot not found"))?;
    image::load_from_memory(png)?; // make sure it really is a picture
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "screenshot".into());
    let dir = p.parent().ok_or_else(|| anyhow::anyhow!("no folder"))?;
    let mut n = 1;
    let out = loop {
        let name = if n == 1 { format!("{stem}_edit.png") } else { format!("{stem}_edit{n}.png") };
        let c = dir.join(&name);
        if !c.exists() {
            break c;
        }
        n += 1;
    };
    std::fs::write(&out, png)?;
    let (inst, _) = key.split_once('/').unwrap_or(("", ""));
    Ok(format!("{inst}/{}", out.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()))
}

pub fn delete(key: &str) -> anyhow::Result<()> {
    let p = resolve(key).ok_or_else(|| anyhow::anyhow!("screenshot not found"))?;
    trash::delete(&p).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}
