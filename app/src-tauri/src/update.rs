//! Longevity's own updates from its GitHub releases (like MioDeck): look at the latest release,
//! download its setup.exe, run it silently and start the new version.

use crate::launcher::util::http;
use serde::Serialize;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "RyandHer-present/longevity";

#[derive(Serialize)]
pub struct AppUpdate {
    current: String,
    /// the newer version, if there is one
    latest: Option<String>,
    notes: String,
    url: Option<String>,
    size: u64,
}

fn ver(s: &str) -> Vec<u32> {
    s.trim().trim_start_matches('v').split('.').map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect()
}

#[tauri::command]
pub async fn update_check() -> Result<AppUpdate, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let r = http().get(format!("https://api.github.com/repos/{REPO}/releases/latest")).header("Accept", "application/vnd.github+json").send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            // no release yet, or GitHub is busy: nothing to do
            return Ok(AppUpdate { current, latest: None, notes: String::new(), url: None, size: 0 });
        }
        let v: serde_json::Value = r.json().map_err(|e| e.to_string())?;
        let tag = v["tag_name"].as_str().unwrap_or("").to_string();
        let asset = v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.to_lowercase().ends_with("-setup.exe"))));
        let newer = ver(&tag) > ver(&current) && asset.is_some();
        Ok(AppUpdate {
            current,
            latest: newer.then(|| tag.trim_start_matches('v').to_string()),
            notes: v["body"].as_str().unwrap_or("").to_string(),
            url: if newer { asset.and_then(|x| x["browser_download_url"].as_str()).map(String::from) } else { None },
            size: asset.and_then(|x| x["size"].as_u64()).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download the new installer (progress as "update-progress" {done, total}), run it silently and
/// start Longevity again once it's done.
#[tauri::command]
pub async fn update_install(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return Err("That isn't a Longevity release".into());
    }
    let dest = std::env::temp_dir().join("Longevity-update-setup.exe");
    let a2 = app.clone();
    let d2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut r = http().get(&url).timeout(std::time::Duration::from_secs(600)).send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("GitHub returned {}", r.status()));
        }
        let total = r.content_length().unwrap_or(0);
        let tmp = d2.with_extension("part");
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 16];
        let (mut done, mut last) = (0u64, 0u64);
        loop {
            let n = r.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if done - last > 256 * 1024 || done == total {
                last = done;
                let _ = a2.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            }
        }
        drop(f);
        if total > 0 && done != total {
            return Err("The download stopped early".into());
        }
        std::fs::rename(&tmp, &d2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    use std::os::windows::process::CommandExt;
    std::process::Command::new("cmd")
        .raw_arg(format!("/C \"\"{}\" /S & start \"\" \"{}\"\"", dest.display(), exe.display()))
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    crate::app::quit(&app);
    Ok(())
}
