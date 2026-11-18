//! Prism Launcher integration: finds Prism, reads its instances, and starts the game through it
//! (Prism keeps the Microsoft login; Mojang must approve any new launcher's sign-in).

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn data_dir() -> PathBuf {
    // MIO_PRISM_DIR points tests at a sandbox copy, so they never touch real instances.
    if let Ok(d) = std::env::var("MIO_PRISM_DIR") {
        return PathBuf::from(d);
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_default();
    base.join("PrismLauncher")
}

pub fn exe() -> Option<PathBuf> {
    let mut c = vec![];
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        c.push(PathBuf::from(&l).join("Programs").join("PrismLauncher").join("prismlauncher.exe"));
    }
    for pf in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(pf) {
            c.push(PathBuf::from(p).join("PrismLauncher").join("prismlauncher.exe"));
        }
    }
    c.push(data_dir().join("prismlauncher.exe"));
    c.into_iter().find(|p| p.is_file())
}

/// Prism's INI-style config files (instance.cfg, prismlauncher.cfg).
pub fn read_cfg(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(t) = std::fs::read_to_string(path) {
        for line in t.lines() {
            if line.starts_with('[') || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                out.entry(k.trim().to_string()).or_insert_with(|| v.trim().trim_matches('"').to_string());
            }
        }
    }
    out
}

/// Set keys in the [General] part of an INI-style cfg, keeping everything else as it was.
pub fn write_cfg_keys(path: &Path, keys: &[(&str, String)]) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| "[General]\n".into());
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    for (k, v) in keys {
        let prefix = format!("{k}=");
        if let Some(l) = lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            *l = format!("{k}={v}");
        } else {
            let at = lines.iter().position(|l| l.trim() == "[General]").map(|i| i + 1).unwrap_or(0);
            lines.insert(at, format!("{k}={v}"));
        }
    }
    let mut s = lines.join("\n");
    s.push('\n');
    std::fs::write(path, s)?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub mc_dir: String,
    pub group: Option<String>,
    pub icon: String,
    pub mc_version: String,
    pub loader: String,
    pub loader_version: String,
    pub total_played: i64,
    pub last_session: i64,
    pub last_launch: i64,
    pub mods: usize,
    pub worlds: usize,
    pub max_mem: i64,
    pub min_mem: i64,
    pub notes: String,
}

pub fn instances_dir() -> PathBuf {
    let cfg = read_cfg(&data_dir().join("prismlauncher.cfg"));
    match cfg.get("InstanceDir") {
        Some(d) if !d.is_empty() => {
            let p = PathBuf::from(d);
            if p.is_absolute() { p } else { data_dir().join(p) }
        }
        _ => data_dir().join("instances"),
    }
}

pub fn mc_dir_of(inst_dir: &Path) -> PathBuf {
    let a = inst_dir.join("minecraft");
    if a.is_dir() {
        return a;
    }
    let b = inst_dir.join(".minecraft");
    if b.is_dir() {
        return b;
    }
    a
}

fn groups() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let p = instances_dir().join("instgroups.json");
    if let Ok(t) = std::fs::read_to_string(p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            if let Some(g) = v.get("groups").and_then(|g| g.as_object()) {
                for (name, body) in g {
                    if let Some(list) = body.get("instances").and_then(|l| l.as_array()) {
                        for i in list {
                            if let Some(s) = i.as_str() {
                                out.insert(s.to_string(), name.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn count_dir(p: &Path, f: impl Fn(&std::fs::DirEntry) -> bool) -> usize {
    std::fs::read_dir(p).map(|rd| rd.flatten().filter(|e| f(e)).count()).unwrap_or(0)
}

pub fn read_instance(dir: &Path, groups: &HashMap<String, String>) -> Option<Instance> {
    let cfg_path = dir.join("instance.cfg");
    if !cfg_path.is_file() {
        return None;
    }
    let cfg = read_cfg(&cfg_path);
    let id = dir.file_name()?.to_string_lossy().to_string();
    let mut mc_version = String::new();
    let mut loader = "vanilla".to_string();
    let mut loader_version = String::new();
    if let Ok(t) = std::fs::read_to_string(dir.join("mmc-pack.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            for c in v.get("components").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                let uid = c.get("uid").and_then(|u| u.as_str()).unwrap_or("");
                let ver = c.get("version").and_then(|u| u.as_str()).unwrap_or("").to_string();
                match uid {
                    "net.minecraft" => mc_version = ver,
                    "net.fabricmc.fabric-loader" => {
                        loader = "fabric".into();
                        loader_version = ver
                    }
                    "org.quiltmc.quilt-loader" => {
                        loader = "quilt".into();
                        loader_version = ver
                    }
                    "net.neoforged" => {
                        loader = "neoforge".into();
                        loader_version = ver
                    }
                    "net.minecraftforge" => {
                        loader = "forge".into();
                        loader_version = ver
                    }
                    _ => {}
                }
            }
        }
    }
    let mc = mc_dir_of(dir);
    let mods = count_dir(&mc.join("mods"), |e| e.file_name().to_string_lossy().to_lowercase().ends_with(".jar"));
    let worlds = count_dir(&mc.join("saves"), |e| e.path().join("level.dat").is_file());
    let num = |k: &str| cfg.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let override_mem = cfg.get("OverrideMemory").map(|v| v == "true").unwrap_or(false);
    let global = read_cfg(&data_dir().join("prismlauncher.cfg"));
    let gnum = |k: &str, d: i64| global.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(d);
    Some(Instance {
        name: cfg.get("name").cloned().unwrap_or_else(|| id.clone()),
        group: groups.get(&id).cloned(),
        icon: cfg.get("iconKey").cloned().unwrap_or_else(|| "default".into()),
        dir: dir.to_string_lossy().to_string(),
        mc_dir: mc.to_string_lossy().to_string(),
        mc_version,
        loader,
        loader_version,
        total_played: num("totalTimePlayed"),
        last_session: num("lastTimePlayed"),
        last_launch: num("lastLaunchTime"),
        mods,
        worlds,
        max_mem: if override_mem { num("MaxMemAlloc") } else { gnum("MaxMemAlloc", 4096) },
        min_mem: if override_mem { num("MinMemAlloc") } else { gnum("MinMemAlloc", 512) },
        notes: cfg.get("notes").cloned().unwrap_or_default(),
        id,
    })
}

pub fn instances() -> Vec<Instance> {
    let g = groups();
    let mut out: Vec<Instance> = std::fs::read_dir(instances_dir())
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                // the crash finder's throwaway copy is not one of yours
                .filter(|e| !super::finder::is_clone(&e.file_name().to_string_lossy()))
                .filter_map(|e| read_instance(&e.path(), &g))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.last_launch.cmp(&a.last_launch).then(a.name.cmp(&b.name)));
    out
}

pub fn safe_id(id: &str) -> bool {
    !(id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\'))
}

pub fn instance(id: &str) -> Option<Instance> {
    if !safe_id(id) {
        return None;
    }
    read_instance(&instances_dir().join(id), &groups())
}

/// Icon image for an instance: custom icons live in Prism's icons folder.
pub fn icon_file(key: &str) -> Option<PathBuf> {
    let dir = data_dir().join("icons");
    for ext in ["png", "jpg", "jpeg", "gif", "ico"] {
        let p = dir.join(format!("{key}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.file_stem().map(|s| s.to_string_lossy() == key).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
pub fn no_window(_c: &mut Command) {}

/// Start an instance through Prism. Prism's console stays hidden, it keeps the login,
/// and it goes away again when the game closes.
pub fn launch(id: &str, server: Option<&str>, world: Option<&str>) -> anyhow::Result<()> {
    if std::env::var("MIO_NO_LAUNCH").is_ok() {
        return Ok(()); // tests: never start the real game
    }
    let exe = exe().ok_or_else(|| anyhow::anyhow!("Prism Launcher isn't installed where expected"))?;
    let mut c = Command::new(&exe);
    c.arg("--launch").arg(id);
    if let Some(s) = server.filter(|s| !s.is_empty()) {
        c.arg("--server").arg(s);
    } else if let Some(w) = world.filter(|s| !s.is_empty()) {
        c.arg("--world").arg(w);
    }
    c.spawn()?;
    Ok(())
}

/// Open Prism's own window (for things only it can do with your login, like uploading a skin).
pub fn open_prism() -> anyhow::Result<()> {
    let exe = exe().ok_or_else(|| anyhow::anyhow!("Prism Launcher isn't installed where expected"))?;
    Command::new(exe).spawn()?;
    Ok(())
}

/// Running games, by instance id: (pid, start time in unix seconds).
pub fn running() -> HashMap<String, (u32, u64)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
    let base = instances_dir().to_string_lossy().replace('\\', "/").to_lowercase();
    let folders: Vec<String> = std::fs::read_dir(instances_dir()).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    let mut out = HashMap::new();
    for (pid, p) in sys.processes() {
        let name = p.name().to_string_lossy().to_lowercase();
        if !name.starts_with("java") {
            continue;
        }
        let cmd: String = p.cmd().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ").replace('\\', "/").to_lowercase();
        if let Some(i) = cmd.find(&base) {
            let rest = cmd[i + base.len()..].trim_start_matches('/');
            let id_lc = rest.split('/').next().unwrap_or("");
            if let Some(real) = folders.iter().find(|f| f.to_lowercase() == id_lc) {
                out.insert(real.clone(), (pid.as_u32(), p.start_time()));
            }
        }
    }
    out
}

pub fn kill(pid: u32) {
    if pid <= 4 || pid == std::process::id() {
        return; // never the system or ourselves
    }
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
    no_window(&mut c);
    let _ = c.output();
}

/// The public profile part of Prism's accounts (names, ids, skins). Login tokens are never read out.
#[derive(Serialize, Clone, Debug)]
pub struct Profile {
    pub name: String,
    pub id: String,
    pub active: bool,
    pub skin_url: Option<String>,
    pub skin_variant: Option<String>,
}

pub fn profiles() -> Vec<Profile> {
    #[derive(serde::Deserialize)]
    struct Skin {
        url: Option<String>,
        variant: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Prof {
        id: Option<String>,
        name: Option<String>,
        skin: Option<Skin>,
    }
    #[derive(serde::Deserialize)]
    struct Acc {
        profile: Option<Prof>,
        active: Option<bool>,
    }
    #[derive(serde::Deserialize)]
    struct File {
        accounts: Vec<Acc>,
    }
    let Ok(t) = std::fs::read_to_string(data_dir().join("accounts.json")) else { return vec![] };
    let Ok(f) = serde_json::from_str::<File>(&t) else { return vec![] };
    f.accounts
        .into_iter()
        .filter_map(|a| {
            let p = a.profile?;
            Some(Profile {
                name: p.name?,
                id: p.id.unwrap_or_default(),
                active: a.active.unwrap_or(false),
                skin_url: p.skin.as_ref().and_then(|s| s.url.clone()).filter(|s| !s.is_empty()),
                skin_variant: p.skin.and_then(|s| s.variant),
            })
        })
        .collect()
}
