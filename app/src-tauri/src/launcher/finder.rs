//! Crash finder: when a crash log doesn't say which mod did it, find it by testing.
//!
//! It makes a throwaway copy of the instance (mod jars hard-linked, configs copied, sound
//! muted) in Longevity's own Prism folder, then starts the game a few times with half of the
//! mods turned off, until one mod (or a clashing pair) is left. The tests run through a
//! separate Prism with an offline test player, on a hidden Windows desktop, so no window ever
//! shows up and your Prism, its instance list and your login are never used.
//! It never opens a world, and the real instance is never changed. The copy is deleted after.
use super::{prism, util::*};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const CLONE_ID: &str = "longevity-crashfinder";
const MARKER: &str = ".longevity-crashfinder";

pub fn is_clone(id: &str) -> bool {
    id.eq_ignore_ascii_case(CLONE_ID)
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub running: bool,
    pub inst: String,
    pub inst_name: String,
    pub phase: String,
    pub test: usize,
    pub tests_est: usize,
    pub left: usize,
    pub lines: Vec<String>,
    pub result: Option<Value>,
    pub started: i64,
}

static STATUS: LazyLock<Mutex<Status>> = LazyLock::new(|| Mutex::new(Status::default()));
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn status() -> Status {
    STATUS.lock().clone()
}
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn update(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let s = {
        let mut g = STATUS.lock();
        f(&mut g);
        g.clone()
    };
    let _ = app.emit("finder", &s);
}
fn say(app: &AppHandle, line: impl Into<String>) {
    let line = line.into();
    update(app, |s| {
        s.lines.push(line);
        if s.lines.len() > 40 {
            s.lines.remove(0);
        }
    });
}

// ---------------------------------------------------------------- mod metadata (ids, provides, depends)

#[derive(Clone, Debug, Default)]
struct ModInfo {
    file: String,
    id: String,
    name: String,
    /// every id this jar answers to (its own, "provides", and mods nested inside it)
    ids: BTreeSet<String>,
    depends: BTreeSet<String>,
}

fn lenient(s: &str) -> Option<Value> {
    let s = s.trim_start_matches('\u{feff}');
    serde_json::from_str(s).ok().or_else(|| serde_json::from_str(&s.replace(['\n', '\r', '\t'], " ")).ok())
}

fn read_fmj<R: Read + std::io::Seek>(z: &mut zip::ZipArchive<R>, depth: u32, info: &mut ModInfo) {
    let mut s = String::new();
    let Ok(mut f) = z.by_name("fabric.mod.json") else { return };
    if f.read_to_string(&mut s).is_err() {
        return;
    }
    drop(f);
    let Some(v) = lenient(&s) else { return };
    let id = v["id"].as_str().unwrap_or("").to_string();
    if depth == 0 {
        info.id = id.clone();
        info.name = v["name"].as_str().unwrap_or(&id).to_string();
        if let Some(d) = v["depends"].as_object() {
            info.depends.extend(d.keys().cloned());
        }
    }
    if !id.is_empty() {
        info.ids.insert(id);
    }
    if let Some(p) = v["provides"].as_array() {
        info.ids.extend(p.iter().filter_map(|x| x.as_str().map(String::from)));
    }
    if depth < 2 {
        let nested: Vec<String> = v["jars"].as_array().map(|a| a.iter().filter_map(|j| j["file"].as_str().map(String::from)).collect()).unwrap_or_default();
        for n in nested {
            let mut buf = vec![];
            if let Ok(mut f) = z.by_name(&n) {
                if f.read_to_end(&mut buf).is_err() {
                    continue;
                }
            } else {
                continue;
            }
            if let Ok(mut inner) = zip::ZipArchive::new(std::io::Cursor::new(buf)) {
                read_fmj(&mut inner, depth + 1, info);
            }
        }
    }
}

fn mod_info(path: &Path) -> ModInfo {
    let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let mut info = ModInfo { file: file.clone(), name: file.clone(), ..Default::default() };
    if let Ok(f) = std::fs::File::open(path) {
        if let Ok(mut z) = zip::ZipArchive::new(f) {
            read_fmj(&mut z, 0, &mut info);
        }
    }
    if info.id.is_empty() {
        info.id = file.trim_end_matches(".jar").to_string();
    }
    info
}

/// Everything a set of mods needs to start: the set plus all its dependencies (by file name).
fn closure(on: &BTreeSet<String>, mods: &BTreeMap<String, ModInfo>, provider: &HashMap<String, String>) -> BTreeSet<String> {
    let mut out = on.clone();
    let mut stack: Vec<String> = on.iter().cloned().collect();
    while let Some(f) = stack.pop() {
        let Some(m) = mods.get(&f) else { continue };
        for d in &m.depends {
            let p = provider.get(d).cloned().or_else(|| if d == "fabric" || d.starts_with("fabric-") { provider.get("fabric-api").cloned() } else { None });
            if let Some(p) = p {
                if out.insert(p.clone()) {
                    stack.push(p);
                }
            }
        }
    }
    out
}

/// Mods that (directly or not) need any of `of`.
fn dependents(of: &BTreeSet<String>, mods: &BTreeMap<String, ModInfo>, provider: &HashMap<String, String>) -> BTreeSet<String> {
    let mut out = of.clone();
    loop {
        let before = out.len();
        for (f, _) in mods {
            if out.contains(f) {
                continue;
            }
            let needs = closure(&BTreeSet::from([f.clone()]), mods, provider);
            if needs.iter().any(|n| n != f && out.contains(n)) {
                out.insert(f.clone());
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

// ---------------------------------------------------------------- the throwaway copy

fn link_or_copy(a: &Path, b: &Path) -> std::io::Result<()> {
    if std::fs::hard_link(a, b).is_err() {
        std::fs::copy(a, b)?;
    }
    Ok(())
}

/// Longevity's own Prism data folder for the tests.
fn root() -> PathBuf {
    data_dir().join("crashfinder")
}

fn clone_dir() -> PathBuf {
    root().join("instances").join(CLONE_ID)
}

/// Folders shared with your Prism through links, so nothing is downloaded again.
const LINKS: &[&str] = &["libraries", "assets", "meta", "java", "cache"];

fn is_link(p: &Path) -> bool {
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return true; // a reparse point: junction or symlink
                }
            }
            m.file_type().is_symlink()
        }
        Err(_) => false,
    }
}

/// Delete the test folder (only if it really is ours). The links go first, so nothing in
/// your real Prism folder can ever be touched.
fn remove_clone() {
    let r = root();
    if r.join(MARKER).exists() {
        for l in LINKS {
            let p = r.join(l);
            if is_link(&p) {
                let _ = std::fs::remove_dir(&p);
            }
        }
        if !LINKS.iter().any(|l| is_link(&r.join(l))) {
            let _ = std::fs::remove_dir_all(&r);
        }
    }
    // older versions kept the copy in the real instances folder
    let old = prism::instances_dir().join(CLONE_ID);
    if old.join(MARKER).exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new("cmd");
    c.raw_arg(format!("/C mklink /J \"{}\" \"{}\"", link.display(), target.display()));
    prism::no_window(&mut c);
    c.output().map(|o| o.status.success()).unwrap_or(false) && is_link(link)
}
#[cfg(not(windows))]
fn junction(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

const TEST_CLIENT: &str = "longevity-crash-test";

/// A local port nothing listens on.
fn dead_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(9)
}

/// The test Prism folder: your Prism settings (Java, memory), the shared downloads, and an
/// offline test player. Your Microsoft login is never copied: Prism only needs to see that
/// this PC has an account that owns the game, so a stand-in entry without any login says so.
fn make_root() -> anyhow::Result<()> {
    remove_clone();
    let r = root();
    if r.exists() {
        anyhow::bail!("Couldn't clear the old test folder ({}). Close anything using it and try again.", r.display());
    }
    let src = prism::data_dir();
    let accounts: Value = read_json(&src.join("accounts.json"));
    let owns = accounts["accounts"].as_array().map(|a| a.iter().any(|x| x["type"] == "MSA" && x["entitlement"]["ownsMinecraft"] == true)).unwrap_or(false);
    if !owns {
        anyhow::bail!("Prism doesn't have a Microsoft account that owns Minecraft, so the test games can't start.");
    }
    std::fs::create_dir_all(r.join("instances"))?;
    std::fs::write(r.join(MARKER), "Longevity crash finder test folder. Safe to delete.")?;
    let cfg = r.join("prismlauncher.cfg");
    if src.join("prismlauncher.cfg").exists() {
        std::fs::copy(src.join("prismlauncher.cfg"), &cfg)?;
    }
    prism::write_cfg_keys(
        &cfg,
        &[
            ("InstanceDir", "instances".into()),
            ("CentralModsDir", "mods".into()),
            ("ShowConsole", "false".into()),
            ("ShowConsoleOnError", "false".into()),
            ("AutoCloseConsole", "true".into()),
            // the test Prism gets no network at all (a proxy on a closed local port): it never
            // contacts Microsoft or downloads anything, and Prism then launches the game offline
            ("ProxyType", "HTTP".into()),
            ("ProxyAddr", "127.0.0.1".into()),
            ("ProxyPort", dead_port().to_string()),
            ("MSAClientIDOverride", TEST_CLIENT.into()),
        ],
    )?;
    if src.join("metacache").is_file() {
        let _ = std::fs::copy(src.join("metacache"), r.join("metacache"));
    }
    for l in LINKS {
        let t = src.join(l);
        if t.is_dir() && !junction(&r.join(l), &t) {
            dlog(&format!("couldn't link {l}; Prism will download it"));
        }
    }
    let now = now_ms() / 1000;
    let acc = json!({
        "formatVersion": 3,
        "accounts": [
            {
                "type": "Offline",
                "active": true,
                "ygg": { "iat": now, "token": "0", "extra": { "userName": "LongevityTest", "clientToken": "4c6f6e676576697479000000000000a1" } },
                "profile": { "id": "4c6f6e676576697479546573740000a1", "name": "LongevityTest", "capes": [], "skin": { "id": "", "url": "", "variant": "" } }
            },
            {
                // a stand-in with no login and no profile: it only tells Prism that you own the game.
                // Prism's check of it fails as "no network", so the test game starts offline.
                "type": "MSA",
                "msa-client-id": TEST_CLIENT,
                "msa": { "token": "", "refresh_token": "none" },
                "entitlement": { "ownsMinecraft": true, "canPlayMinecraft": true }
            }
        ]
    });
    std::fs::write(r.join("accounts.json"), serde_json::to_string_pretty(&acc)?)?;
    Ok(())
}

fn make_clone(src: &prism::Instance) -> anyhow::Result<PathBuf> {
    make_root()?;
    let d = clone_dir();
    let sdir = PathBuf::from(&src.dir);
    let smc = PathBuf::from(&src.mc_dir);
    let dmc = d.join("minecraft");
    std::fs::create_dir_all(&dmc)?;
    std::fs::write(d.join(MARKER), "Longevity crash finder copy. Safe to delete.")?;
    for f in ["instance.cfg", "mmc-pack.json"] {
        if sdir.join(f).exists() {
            std::fs::copy(sdir.join(f), d.join(f))?;
        }
    }
    for sub in ["patches", "libraries", "jarmods"] {
        if sdir.join(sub).is_dir() {
            copy_dir(&sdir.join(sub), &d.join(sub))?;
        }
    }
    prism::write_cfg_keys(
        &d.join("instance.cfg"),
        &[
            ("name", "Longevity crash test".into()),
            ("OverrideConsole", "true".into()),
            ("ShowConsole", "false".into()),
            ("ShowConsoleOnError", "false".into()),
            ("AutoCloseConsole", "true".into()),
            ("OverrideWindow", "true".into()),
            ("LaunchMaximized", "false".into()),
            ("MinecraftWinWidth", "320".into()),
            ("MinecraftWinHeight", "240".into()),
            ("totalTimePlayed", "0".into()),
            ("lastTimePlayed", "0".into()),
            ("lastLaunchTime", "0".into()),
            ("ManagedPack", "false".into()),
            ("UseAccountForInstance", "false".into()),
            ("InstanceAccountId", "".into()),
        ],
    )?;
    // mods: hard links (the game never writes to its jars), only the ones that are on
    std::fs::create_dir_all(dmc.join("mods"))?;
    for e in std::fs::read_dir(smc.join("mods"))?.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.ends_with(".jar") && e.path().is_file() {
            link_or_copy(&e.path(), &dmc.join("mods").join(&n))?;
        }
    }
    // configs: real copies (mods write to them), skipping anything huge
    let mut budget: u64 = 200 * 1024 * 1024;
    fn copy_cfg(from: &Path, to: &Path, budget: &mut u64, depth: u32) {
        let Ok(rd) = std::fs::read_dir(from) else { return };
        let _ = std::fs::create_dir_all(to);
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 6 {
                    copy_cfg(&p, &to.join(e.file_name()), budget, depth + 1);
                }
            } else if let Ok(m) = e.metadata() {
                if m.len() <= 4 * 1024 * 1024 && m.len() <= *budget {
                    if std::fs::copy(&p, to.join(e.file_name())).is_ok() {
                        *budget -= m.len();
                    }
                }
            }
        }
    }
    copy_cfg(&smc.join("config"), &dmc.join("config"), &mut budget, 0);
    // options: theirs, but muted, windowed and never pausing on focus loss
    if smc.join("options.txt").exists() {
        let t = std::fs::read_to_string(smc.join("options.txt")).unwrap_or_default();
        let mut out = String::new();
        for l in t.lines() {
            let k = l.split(':').next().unwrap_or("");
            let l = match k {
                "soundCategory_master" => "soundCategory_master:0.0".to_string(),
                "fullscreen" => "fullscreen:false".to_string(),
                "exclusiveFullscreen" => "exclusiveFullscreen:false".to_string(),
                "pauseOnLostFocus" => "pauseOnLostFocus:false".to_string(),
                "onboardAccessibility" => "onboardAccessibility:false".to_string(),
                _ => l.to_string(),
            };
            out.push_str(&l);
            out.push('\n');
        }
        if !out.contains("soundCategory_master:") {
            out.push_str("soundCategory_master:0.0\n");
        }
        std::fs::write(dmc.join("options.txt"), out)?;
    } else {
        std::fs::write(dmc.join("options.txt"), "soundCategory_master:0.0\nonboardAccessibility:false\n")?;
    }
    // packs and shaders (a broken pack can crash the game too): hard links
    for sub in ["resourcepacks", "shaderpacks"] {
        if let Ok(rd) = std::fs::read_dir(smc.join(sub)) {
            std::fs::create_dir_all(dmc.join(sub))?;
            for e in rd.flatten() {
                if e.path().is_file() {
                    let _ = link_or_copy(&e.path(), &dmc.join(sub).join(e.file_name()));
                } else if e.path().is_dir() {
                    let _ = copy_dir(&e.path(), &dmc.join(sub).join(e.file_name()));
                }
            }
        }
    }
    Ok(dmc)
}

// ---------------------------------------------------------------- one test

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Crash(String),
    Fine,
    Hang,
    Cancelled,
    Failed(String),
}

fn set_enabled(mc: &Path, on: &BTreeSet<String>) {
    let dir = mc.join("mods");
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        let base = n.trim_end_matches(".disabled").to_string();
        if !base.ends_with(".jar") {
            continue;
        }
        let want_on = on.contains(&base);
        let is_on = !n.ends_with(".disabled");
        if want_on && !is_on {
            let _ = std::fs::rename(e.path(), dir.join(&base));
        } else if !want_on && is_on {
            let _ = std::fs::rename(e.path(), dir.join(format!("{base}.disabled")));
        }
    }
}

/// A small diagnostics log (launcher data dir / finder.log): what was hidden, and when.
fn dlog(line: &str) {
    use std::io::Write;
    let p = data_dir().join("finder.log");
    if std::fs::metadata(&p).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&p);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} {line}", now_ms());
    }
}

const DESKTOP: &str = "LongevityCrashTests";
/// The hidden desktop the tests run on (0 = none yet).
static DESK: LazyLock<Mutex<usize>> = LazyLock::new(|| Mutex::new(0));
/// The tests are on the hidden desktop (else they run on yours and their windows get hidden).
static ON_DESKTOP: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn open_desktop() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::CreateDesktopW;
    let mut d = DESK.lock();
    if *d != 0 {
        return true;
    }
    let name: Vec<u16> = DESKTOP.encode_utf16().chain([0]).collect();
    let h = unsafe { CreateDesktopW(name.as_ptr(), std::ptr::null(), std::ptr::null(), 0, 0x1000_0000, std::ptr::null()) };
    if h.is_null() {
        dlog(&format!("no hidden desktop: {}", std::io::Error::last_os_error()));
        return false;
    }
    *d = h as usize;
    true
}
#[cfg(windows)]
fn close_desktop() {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, HDESK};
    let mut d = DESK.lock();
    if *d != 0 {
        unsafe { CloseDesktop(*d as HDESK) };
        *d = 0;
    }
}
#[cfg(not(windows))]
fn close_desktop() {}

#[cfg(windows)]
fn spawn_on_desktop(exe: &Path, dir: &Path) -> anyhow::Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW};
    let mut desk: Vec<u16> = DESKTOP.encode_utf16().chain([0]).collect();
    let cmd = format!("\"{}\" --dir \"{}\" --launch {} --offline LongevityTest", exe.display(), dir.display(), CLONE_ID);
    let mut cmdw: Vec<u16> = cmd.encode_utf16().chain([0]).collect();
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.lpDesktop = desk.as_mut_ptr();
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { CreateProcessW(std::ptr::null(), cmdw.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 0, 0, std::ptr::null(), std::ptr::null(), &si, &mut pi) };
    if ok == 0 {
        anyhow::bail!("couldn't start Prism: {}", std::io::Error::last_os_error());
    }
    unsafe {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }
    dlog(&format!("Prism pid {} started on the hidden desktop", pi.dwProcessId));
    Ok(())
}

/// Start the test copy through Longevity's own Prism folder, on the hidden desktop if possible.
fn launch_test() -> anyhow::Result<()> {
    if std::env::var("MIO_NO_LAUNCH").is_ok() {
        return Ok(());
    }
    let exe = prism::exe().ok_or_else(|| anyhow::anyhow!("Prism Launcher isn't installed where expected"))?;
    let dir = root();
    #[cfg(windows)]
    {
        if open_desktop() {
            match spawn_on_desktop(&exe, &dir) {
                Ok(()) => {
                    ON_DESKTOP.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                Err(e) => dlog(&e.to_string()),
            }
        }
    }
    ON_DESKTOP.store(false, Ordering::SeqCst);
    let mut c = std::process::Command::new(&exe);
    c.arg("--dir").arg(&dir).arg("--launch").arg(CLONE_ID).arg("--offline").arg("LongevityTest");
    c.spawn()?;
    Ok(())
}

/// The Prism processes running from Longevity's test folder (never yours).
fn our_prism() -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
    let key = root().to_string_lossy().replace('\\', "/").to_lowercase();
    sys.processes()
        .iter()
        .filter(|(_, p)| p.name().to_string_lossy().to_lowercase().starts_with("prismlauncher"))
        .filter(|(_, p)| p.cmd().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ").replace('\\', "/").to_lowercase().contains(&key))
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

fn stop_our_prism() {
    let ps = our_prism();
    if ps.is_empty() {
        return;
    }
    for p in &ps {
        prism::kill(*p);
    }
    let t = Instant::now();
    while !our_prism().is_empty() && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Java processes of the current test; their windows are hidden the moment they appear.
static HIDE_PIDS: LazyLock<Mutex<Vec<u32>>> = LazyLock::new(|| Mutex::new(vec![]));
/// While a test runs, Prism's "Please wait..." launch dialog is hidden too.
static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);

/// A window-shown hook: hides the test's windows (and Prism's launch dialog) as they appear,
/// before they can be noticed. Polling below is the backup.
#[cfg(windows)]
fn start_hook() {
    if HOOK_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| unsafe {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, EVENT_OBJECT_SHOW, GetClassNameW, GetMessageW, GetWindowTextW, GetWindowThreadProcessId, MSG, OBJID_WINDOW, SW_HIDE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos, ShowWindow,
            TranslateMessage, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
        };
        unsafe extern "system" fn cb(_h: HWINEVENTHOOK, _ev: u32, hwnd: HWND, id_object: i32, _child: i32, _thread: u32, _time: u32) {
            if !HOOK_ACTIVE.load(Ordering::Relaxed) || id_object != OBJID_WINDOW || hwnd.is_null() {
                return;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            let mut hide = HIDE_PIDS.lock().contains(&pid);
            if !hide && !ON_DESKTOP.load(Ordering::Relaxed) {
                let mut cls = [0u16; 64];
                let n = unsafe { GetClassNameW(hwnd, cls.as_mut_ptr(), 64) } as usize;
                let cls = String::from_utf16_lossy(&cls[..n]);
                if cls.starts_with("Qt") {
                    let mut t = [0u16; 128];
                    let n = unsafe { GetWindowTextW(hwnd, t.as_mut_ptr(), 128) } as usize;
                    let title = String::from_utf16_lossy(&t[..n]);
                    // Prism's launch dialog and its console window for our test copy
                    hide = (title.starts_with("Please wait") && title.contains("Prism")) || title.contains("Longevity crash test");
                }
            }
            if hide {
                unsafe {
                    SetWindowPos(hwnd, std::ptr::null_mut(), -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    dlog(&format!("hook hid a window of pid {pid}"));
                    ShowWindow(hwnd, SW_HIDE);
                }
            }
        }
        let hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, std::ptr::null_mut(), Some(cb), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if hook.is_null() {
            HOOK_STARTED.store(false, Ordering::SeqCst);
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
#[cfg(not(windows))]
fn start_hook() {}

/// Backup for the hook: hide any visible window of these processes, and Prism's launch dialog.
#[cfg(windows)]
fn hide_windows_of(pids: &[u32]) {
    *HIDE_PIDS.lock() = pids.to_vec();
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SW_HIDE, SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW;
        let pids = unsafe { &*(l as *const Vec<u32>) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        let mine = pids.contains(&pid) || !ON_DESKTOP.load(Ordering::Relaxed) && {
            let mut t = [0u16; 128];
            let n = unsafe { GetWindowTextW(h, t.as_mut_ptr(), 128) } as usize;
            let title = String::from_utf16_lossy(&t[..n]);
            (title.starts_with("Please wait") && title.contains("Prism")) || title.contains("Longevity crash test")
        };
        if mine && unsafe { IsWindowVisible(h) } != 0 {
            unsafe {
                SetWindowPos(h, std::ptr::null_mut(), -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                dlog(&format!("poll hid a window of pid {pid}"));
                ShowWindow(h, SW_HIDE);
            }
        }
        1
    }
    let v: Vec<u32> = pids.to_vec();
    unsafe { EnumWindows(Some(cb), &v as *const Vec<u32> as LPARAM) };
}
#[cfg(not(windows))]
fn hide_windows_of(_pids: &[u32]) {}

/// Java processes that belong to the test: the game itself plus Fabric's forked error window.
fn test_pids(since_unix: u64) -> (Option<u32>, Vec<u32>) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
    let marker = format!("/{}/", CLONE_ID);
    let mut game = None;
    let mut all = vec![];
    for (pid, p) in sys.processes() {
        if !p.name().to_string_lossy().to_lowercase().starts_with("java") {
            continue;
        }
        let cmd = p.cmd().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ").replace('\\', "/").to_lowercase();
        if cmd.contains(&marker) {
            if p.start_time() + 2 >= since_unix {
                game = Some(pid.as_u32());
            }
            all.push(pid.as_u32());
        } else if p.start_time() + 2 >= since_unix && cmd.contains("loader.impl.gui") {
            all.push(pid.as_u32());
        }
    }
    (game, all)
}

fn crash_text(mc: &Path, since_ms: i64) -> Option<String> {
    let mut best: Option<(i64, PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(mc.join("crash-reports")) {
        for e in rd.flatten() {
            let t = mtime_ms(&e.path());
            if t >= since_ms && best.as_ref().map(|b| t > b.0).unwrap_or(true) {
                best = Some((t, e.path()));
            }
        }
    }
    if let Some((_, p)) = best {
        return std::fs::read_to_string(p).ok();
    }
    let log = std::fs::read_to_string(mc.join("logs").join("latest.log")).unwrap_or_default();
    for m in ["---- Minecraft Crash Report ----", "Incompatible mods found", "Mod resolution failed", "Mixin apply failed", "MixinApplyError", "Could not execute entrypoint"] {
        if log.contains(m) {
            return Some(log);
        }
    }
    None
}

/// A one-line reason from a crash report or log.
fn crash_line(text: &str) -> String {
    for l in text.lines() {
        if let Some(d) = l.strip_prefix("Description: ") {
            let ex = text.lines().skip_while(|x| !x.starts_with("Description: ")).nth(2).unwrap_or("").trim();
            return if ex.is_empty() { d.to_string() } else { format!("{d}: {}", ex.chars().take(140).collect::<String>()) };
        }
    }
    text.lines().find(|l| l.contains("Exception") || l.contains("Error")).map(|l| l.trim().chars().take(160).collect()).unwrap_or_else(|| "crashed".into())
}

fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let p = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
    sys.process(p).is_some()
}

/// Make sure no test game from an earlier test is still around.
fn clear_old_games() {
    let (_, all) = test_pids(u64::MAX);
    if all.is_empty() {
        return;
    }
    kill_all(&all);
    let t = Instant::now();
    while !test_pids(u64::MAX).1.is_empty() && t.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn kill_all(pids: &[u32]) {
    for p in pids {
        prism::kill(*p);
    }
}

fn trial(app: &AppHandle, mc: &Path, on: &BTreeSet<String>) -> Outcome {
    start_hook();
    HOOK_ACTIVE.store(true, Ordering::SeqCst);
    let r = trial_inner(app, mc, on);
    // let Prism finish closing its dialog before we stop hiding it
    let t = Instant::now();
    while !ON_DESKTOP.load(Ordering::SeqCst) && t.elapsed() < Duration::from_millis(1500) {
        hide_windows_of(&[]);
        std::thread::sleep(Duration::from_millis(50));
    }
    HOOK_ACTIVE.store(false, Ordering::SeqCst);
    HIDE_PIDS.lock().clear();
    r
}

fn trial_inner(app: &AppHandle, mc: &Path, on: &BTreeSet<String>) -> Outcome {
    clear_old_games();
    set_enabled(mc, on);
    let _ = std::fs::remove_file(mc.join("logs").join("latest.log"));
    let _ = std::fs::remove_dir_all(mc.join("crash-reports"));
    let since_ms = now_ms();
    let since_unix = (since_ms / 1000) as u64;
    if let Err(e) = launch_test() {
        return Outcome::Failed(e.to_string());
    }
    // wait for the game to start
    let t0 = Instant::now();
    let pid = loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Outcome::Cancelled;
        }
        let (g, all) = test_pids(since_unix);
        hide_windows_of(&all);
        if let Some(p) = g {
            dlog(&format!("test game pid {p}"));
            break p;
        }
        if t0.elapsed() > Duration::from_secs(90) {
            return Outcome::Failed("Prism didn't start the test game.".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let _ = app;
    let started = Instant::now();
    let mut ready_at: Option<Instant> = None;
    let mut last_check = Instant::now() - Duration::from_secs(5);
    loop {
        let (_, mut all) = test_pids(since_unix);
        if !all.contains(&pid) {
            all.push(pid);
        }
        hide_windows_of(&all);
        if CANCEL.load(Ordering::SeqCst) {
            kill_all(&all);
            return Outcome::Cancelled;
        }
        let alive = pid_alive(pid);
        if last_check.elapsed() > Duration::from_millis(700) || !alive {
            last_check = Instant::now();
            if let Some(t) = crash_text(mc, since_ms) {
                // give it a moment to finish writing, then make sure it's gone
                std::thread::sleep(Duration::from_millis(1500));
                let t = crash_text(mc, since_ms).unwrap_or(t);
                let mut all = test_pids(since_unix).1;
                all.push(pid);
                kill_all(&all);
                wait_gone(since_unix);
                return Outcome::Crash(crash_line(&t));
            }
            if !alive {
                std::thread::sleep(Duration::from_millis(1500));
                if let Some(t) = crash_text(mc, since_ms) {
                    return Outcome::Crash(crash_line(&t));
                }
                return if ready_at.is_some() { Outcome::Fine } else { Outcome::Crash("closed while starting, without a crash report".into()) };
            }
            let log = std::fs::read_to_string(mc.join("logs").join("latest.log")).unwrap_or_default();
            if ready_at.is_none() && log.contains("textures/atlas/blocks.png-atlas") {
                ready_at = Some(Instant::now());
            }
            if let Some(r) = ready_at {
                // made it to the title screen and stayed up a while: fine
                if r.elapsed() > Duration::from_secs(12) {
                    kill_all(&all);
                    wait_gone(since_unix);
                    return Outcome::Fine;
                }
            }
            if started.elapsed() > Duration::from_secs(360) {
                kill_all(&all);
                wait_gone(since_unix);
                return Outcome::Hang;
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn wait_gone(since_unix: u64) {
    let _ = since_unix;
    let t = Instant::now();
    while !test_pids(u64::MAX).1.is_empty() && t.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(250));
    }
}

// ---------------------------------------------------------------- the search

struct Search<'a> {
    app: &'a AppHandle,
    mc: &'a Path,
    mods: &'a BTreeMap<String, ModInfo>,
    provider: &'a HashMap<String, String>,
    tests: usize,
}

impl Search<'_> {
    fn name(&self, f: &str) -> String {
        self.mods.get(f).map(|m| m.name.clone()).unwrap_or_else(|| f.to_string())
    }
    /// Does the game crash with these mods (and what they need) on?
    fn crashes(&mut self, on: &BTreeSet<String>, what: &str) -> anyhow::Result<bool> {
        let set = closure(on, self.mods, self.provider);
        self.tests += 1;
        let n = self.tests;
        update(self.app, |s| {
            s.test = n;
            s.phase = what.to_string();
            s.tests_est = s.tests_est.max(n + 1);
        });
        say(self.app, format!("Test {n}: {what} ({} mods on)", set.len()));
        let mut out = trial(self.app, self.mc, &set);
        if matches!(&out, Outcome::Crash(w) if w.starts_with("closed while starting")) {
            say(self.app, "  it closed without saying why, trying that one again");
            out = trial(self.app, self.mc, &set);
        }
        match out {
            Outcome::Crash(why) => {
                say(self.app, format!("  crashed: {why}"));
                Ok(true)
            }
            Outcome::Fine => {
                say(self.app, "  started fine");
                Ok(false)
            }
            Outcome::Hang => {
                say(self.app, "  got stuck loading (counted as a crash)");
                Ok(true)
            }
            Outcome::Cancelled => anyhow::bail!("cancelled"),
            Outcome::Failed(e) => anyhow::bail!(e),
        }
    }

    /// The smallest part of `cands` that still crashes with `fixed` on (delta debugging, halving).
    fn find(&mut self, cands: Vec<String>, fixed: &BTreeSet<String>) -> anyhow::Result<Vec<String>> {
        update(self.app, |s| s.left = cands.len());
        if cands.len() <= 1 {
            return Ok(cands);
        }
        let mid = cands.len() / 2;
        let (a, b) = (cands[..mid].to_vec(), cands[mid..].to_vec());
        let with = |part: &[String]| -> BTreeSet<String> { fixed.iter().cloned().chain(part.iter().cloned()).collect() };
        if self.crashes(&with(&a), &format!("checking {} of {} mods", a.len(), cands.len()))? {
            return self.find(a, fixed);
        }
        if self.crashes(&with(&b), &format!("checking the other {} mods", b.len()))? {
            return self.find(b, fixed);
        }
        // neither half alone: it takes mods from both halves
        say(self.app, "  neither half crashes alone, so two mods are clashing");
        let fa: BTreeSet<String> = fixed.iter().cloned().chain(b.iter().cloned()).collect();
        let x = self.find(a, &fa)?;
        let fb: BTreeSet<String> = fixed.iter().cloned().chain(x.iter().cloned()).collect();
        let y = self.find(b, &fb)?;
        Ok(x.into_iter().chain(y).collect())
    }
}

fn run(app: &AppHandle, inst: &prism::Instance) -> anyhow::Result<Value> {
    say(app, format!("Making a throwaway copy of {}", inst.name));
    let mc = make_clone(inst)?;
    // the mods that are on in the real instance
    let mut mods: BTreeMap<String, ModInfo> = BTreeMap::new();
    for e in std::fs::read_dir(mc.join("mods"))?.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.ends_with(".jar") {
            mods.insert(n, mod_info(&e.path()));
        }
    }
    let mut provider: HashMap<String, String> = HashMap::new();
    for (f, m) in &mods {
        for id in &m.ids {
            provider.entry(id.clone()).or_insert_with(|| f.clone());
        }
    }
    let all: BTreeSet<String> = mods.keys().cloned().collect();
    // every mod, no mods, the halving, and the final check
    let est = (all.len().max(2) as f64).log2().ceil() as usize + 3;
    update(app, |s| {
        s.tests_est = est;
        s.left = all.len();
    });
    let mut search = Search { app, mc: &mc, mods: &mods, provider: &provider, tests: 0 };

    // 1. does it crash at all while starting?
    if !search.crashes(&all, "starting with every mod, like you play")? {
        return Ok(json!({ "kind": "no_crash", "tests": search.tests }));
    }
    // 2. with no mods at all? (then it's not a mod)
    if search.crashes(&BTreeSet::new(), "starting with no mods")? {
        return Ok(json!({ "kind": "not_mods", "tests": search.tests }));
    }
    // 3. halve: libraries last, so the first split is between the mods you picked
    let mut cands: Vec<String> = all.iter().cloned().collect();
    let needed_by: HashMap<String, usize> = cands
        .iter()
        .map(|f| {
            let n = mods.values().filter(|m| m.file != *f && m.depends.iter().any(|d| provider.get(d) == Some(f))).count();
            (f.clone(), n)
        })
        .collect();
    cands.sort_by_key(|f| (needed_by.get(f).copied().unwrap_or(0), f.to_lowercase()));
    let found = search.find(cands, &BTreeSet::new())?;
    // 4. check: everything except the culprit(s) and what needs them should start
    let found_set: BTreeSet<String> = found.iter().cloned().collect();
    let gone = dependents(&found_set, &mods, &provider);
    let rest: BTreeSet<String> = all.difference(&gone).cloned().collect();
    let confirmed = !search.crashes(&rest, "making sure: everything except what was found")?;
    let culprits: Vec<Value> = found
        .iter()
        .map(|f| {
            let m = mods.get(f);
            let needed: Vec<String> = gone.iter().filter(|g| !found_set.contains(*g)).map(|g| search.name(g)).collect();
            json!({ "file": f, "id": m.map(|m| m.id.clone()), "name": search.name(f), "needed_by": needed })
        })
        .collect();
    Ok(json!({ "kind": if found.len() > 1 { "clash" } else { "mod" }, "culprits": culprits, "confirmed": confirmed, "tests": search.tests }))
}

pub fn start(app: AppHandle, inst_id: String) -> anyhow::Result<()> {
    if STATUS.lock().running {
        anyhow::bail!("The crash finder is already running.");
    }
    let inst = prism::instance(&inst_id).ok_or_else(|| anyhow::anyhow!("instance not found"))?;
    if prism::running().contains_key(&inst.id) {
        anyhow::bail!("Close {} first.", inst.name);
    }
    CANCEL.store(false, Ordering::SeqCst);
    update(&app, |s| {
        *s = Status { running: true, inst: inst.id.clone(), inst_name: inst.name.clone(), phase: "Getting ready".into(), started: now_ms(), ..Default::default() };
    });
    std::thread::spawn(move || {
        let r = run(&app, &inst);
        // our own Prism (never yours), any test game, the test folder and the hidden desktop
        stop_our_prism();
        kill_all(&test_pids(u64::MAX).1);
        if std::env::var_os("LONGEVITY_FINDER_KEEP").is_none() {
            remove_clone();
        }
        close_desktop();
        let result = match r {
            Ok(v) => v,
            Err(e) if e.to_string() == "cancelled" => json!({ "kind": "cancelled" }),
            Err(e) => json!({ "kind": "error", "error": e.to_string() }),
        };
        update(&app, |s| {
            s.running = false;
            s.phase = "Done".into();
            s.result = Some(result);
        });
    });
    Ok(())
}

/// Turn a found mod off in the real instance (renames it to .disabled; the Mods page can turn it back on).
pub fn disable_in(inst_id: &str, file: &str) -> anyhow::Result<()> {
    if file.contains('/') || file.contains('\\') || file.contains("..") || !file.ends_with(".jar") {
        anyhow::bail!("bad file");
    }
    let inst = prism::instance(inst_id).ok_or_else(|| anyhow::anyhow!("instance not found"))?;
    let dir = PathBuf::from(&inst.mc_dir).join("mods");
    let p = dir.join(file);
    if !p.exists() {
        anyhow::bail!("{file} isn't in the mods folder any more");
    }
    std::fs::rename(&p, dir.join(format!("{file}.disabled")))?;
    Ok(())
}

/// Clear a finished result (the card was closed).
pub fn dismiss() {
    let mut s = STATUS.lock();
    if !s.running {
        *s = Status::default();
    }
}

/// On start-up: a copy left behind by a crash of Longevity itself.
pub fn cleanup_leftovers() {
    if !STATUS.lock().running {
        stop_our_prism();
        remove_clone();
    }
}
