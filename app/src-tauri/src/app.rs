//! Longevity's shell: the main window (created on demand, destroyed while you play so the GPU can
//! sleep), the tray icon, starting with Windows, and the watcher that notices Minecraft starting and
//! stopping.

use crate::launcher;
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

type R<T> = Result<T, String>;

static CREATING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct Shell {
    /// Instances running right now (id -> (pid, start secs)).
    pub running: Mutex<HashMap<String, (u32, u64)>>,
    /// The window was open when a game started, so it comes back when the game closes.
    pub reopen_after_game: AtomicBool,
}

/// Automated test runs: off-screen, no one-copy rule, a debug port for driving the page.
pub fn testing() -> bool {
    std::env::var_os("LONGEVITY_OFFSCREEN").is_some()
}

/// The WebView2 flags every window must share: WebView2 refuses to make a second window with
/// different flags in the same data folder, so the recap card uses exactly the main window's.
pub fn browser_args(app: &AppHandle) -> String {
    let base = app.config().app.windows.iter().find(|w| w.label == "main").and_then(|w| w.additional_browser_args.clone()).unwrap_or_default();
    if testing() {
        let port = std::env::var("LONGEVITY_CDP_PORT").unwrap_or_else(|_| "9334".into());
        format!("{base} --remote-debugging-port={port}")
    } else {
        base
    }
}

/// Open (or re-create) the main window. Never call window creation inside a tray/menu callback
/// directly: it deadlocks the event loop, so it always happens on its own thread.
pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        if !testing() {
            let _ = w.set_focus();
        }
        return;
    }
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(mut cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
            let test = testing();
            if test {
                // centering would win over the off-screen position and flash it onto the screen
                cfg.center = false;
                cfg.x = Some(-5200.0);
                cfg.y = Some(-5200.0);
            }
            let built = tauri::WebviewWindowBuilder::from_config(&app, &cfg).map(|b| {
                if test {
                    b.position(-5200.0, -5200.0).skip_taskbar(true).additional_browser_args(&browser_args(&app))
                } else {
                    b
                }
            });
            if let Ok(w) = built.and_then(|b| b.build()) {
                if test {
                    // Tauri makes the window at (0,0) and moves it later: park it now, before the
                    // page can show it there
                    park_test_windows();
                }
                // the page shows itself once it has painted (no white flash); this is a fallback
                let w2 = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if !w2.is_visible().unwrap_or(true) {
                        let _ = w2.show();
                    }
                });
            }
        }
        CREATING.store(false, Ordering::SeqCst);
    });
}

/// Close the window but keep running in the tray (frees the GPU and memory of the web view).
pub fn sleep(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
}

pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub async fn close_window(app: AppHandle) -> R<()> {
    sleep(&app);
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    quit(&app);
}

// ---------------------------------------------------------------- start with Windows

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "Longevity";

fn installed_copy() -> bool {
    std::env::current_exe().map(|p| !p.to_string_lossy().contains(r"\target\")).unwrap_or(false)
}

#[tauri::command]
pub fn get_autostart() -> bool {
    let hk = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    hk.open_subkey(RUN_KEY).and_then(|k| k.get_value::<String, _>(RUN_NAME)).is_ok()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> R<bool> {
    let hk = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (k, _) = hk.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        k.set_value(RUN_NAME, &format!("\"{}\" --hidden", exe.to_string_lossy())).map_err(|e| e.to_string())?;
    } else {
        let _ = k.delete_value(RUN_NAME);
    }
    Ok(get_autostart())
}

// ---------------------------------------------------------------- setup

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let open = MenuItem::with_id(app, "open", "Open Longevity", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_i])?;
    if !testing() {
        let icon = app.default_window_icon().cloned();
        let mut tb = TrayIconBuilder::with_id("tray").tooltip("Longevity").menu(&menu).show_menu_on_left_click(false);
        if let Some(i) = icon {
            tb = tb.icon(i);
        }
        tb.on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    }

    // First run of an installed copy: start with Windows, quietly in the tray (the user's choice).
    if installed_copy() && !testing() {
        let marker = atlascore::data_dir().join("autostart-initialized");
        if !marker.exists() {
            let _ = set_autostart(true);
            let _ = std::fs::write(&marker, b"1");
        }
    }

    let hidden = std::env::args().any(|a| a == "--hidden");
    if !hidden {
        show(&handle);
    }
    let h = handle.clone();
    std::thread::spawn(move || watcher(h));
    let h2 = handle.clone();
    std::thread::spawn(move || crate::tools::recap::streak_watch(h2));
    // a crash-finder copy left behind if Longevity was closed mid-search
    std::thread::spawn(launcher::finder::cleanup_leftovers);
    if testing() {
        // tests run off-screen; Windows pulls off-screen windows back when the display changes
        // (a test game starting can do that), and WebView2 adds helper windows that reach onto
        // the screen, so keep every window of ours off it
        std::thread::spawn(|| loop {
            park_test_windows();
            std::thread::sleep(std::time::Duration::from_millis(40));
        });
    }
    // a recap you haven't looked at yet comes back after a restart
    let h3 = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if tauri::async_runtime::block_on(crate::tools::recap::t_recap_latest()).map(|v| !v.is_null()).unwrap_or(false) {
            crate::tools::recap::show_card(&h3);
        }
    });
    Ok(())
}

pub fn on_run_event(app: &AppHandle, e: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { code, api, .. } = e {
        // The last window closing must not end the app: it lives on in the tray.
        if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
            api.prevent_exit();
        }
    }
    let _ = app;
}

// ---------------------------------------------------------------- game watcher

/// Notices Minecraft starting and stopping. While a game runs, the window sleeps in the tray.
fn watcher(app: AppHandle) {
    let mut prev: HashMap<String, (u32, u64)> = HashMap::new();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let mut now = launcher::prism::running();
        now.retain(|k, _| !launcher::finder::is_clone(k));
        for (id, v) in &now {
            if !prev.contains_key(id) {
                let _ = app.emit("game-started", json!({ "id": id }));
                // remember the stats now, so the recap afterwards is an exact difference
                let iid = id.clone();
                std::thread::spawn(move || {
                    crate::tools::recap::before_game(&iid);
                    launcher::sync::before_game(&iid);
                });
                let lstate = app.state::<launcher::LState>();
                lstate.launched.lock().entry(id.clone()).or_insert((v.1 as i64) * 1000);
                if !testing() && app.get_webview_window("main").is_some() {
                    app.state::<Shell>().reopen_after_game.store(true, Ordering::SeqCst);
                    // give the page a moment to save anything it was doing
                    let h = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        sleep(&h);
                    });
                }
            }
        }
        for (id, v) in &prev {
            if !now.contains_key(id) {
                let lstate = app.state::<launcher::LState>();
                let since = lstate.launched.lock().remove(id).unwrap_or((v.1 as i64) * 1000) - 5000;
                let report = launcher::prism::instance(id).and_then(|i| {
                    let mc = std::path::PathBuf::from(&i.mc_dir);
                    launcher::crash::newest_since(&mc, since, &launcher::mods::installed(&mc))
                });
                let crashed = report.is_some();
                let _ = app.emit("game-stopped", json!({ "id": id, "crash": report }));
                crate::tools::after_game(&app, id, v.1 as i64 * 1000, crashed);
                // settings changed in that game -> the other instance of the sync pair
                {
                    let (h, iid) = (app.clone(), id.clone());
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2500));
                        if let Some(note) = launcher::sync::after_game(&iid) {
                            let _ = h.emit("sync-note", json!({ "text": note }));
                        }
                    });
                }
                let shell = app.state::<Shell>();
                if crashed || shell.reopen_after_game.swap(false, Ordering::SeqCst) {
                    show(&app);
                }
            }
        }
        *app.state::<Shell>().running.lock() = now.clone();
        prev = now;
    }
}

/// Tests only: move every window of this process that reaches onto the screen far off it.
#[cfg(windows)]
pub fn park_test_windows() {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowThreadProcessId, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos};
    unsafe extern "system" fn cb(h: HWND, me: LPARAM) -> BOOL {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        if pid as LPARAM != me {
            return 1;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetWindowRect(h, &mut r) } == 0 {
            return 1;
        }
        let (w, ht) = (r.right - r.left, r.bottom - r.top);
        // tiny message/event windows don't matter; anything bigger that reaches x or y > -3000 does
        if w > 40 && ht > 40 && r.right > -3000 && r.bottom > -3000 {
            unsafe { SetWindowPos(h, std::ptr::null_mut(), -6000 - w, -6000 - ht, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) };
        }
        1
    }
    let me = unsafe { GetCurrentProcessId() } as LPARAM;
    unsafe { EnumWindows(Some(cb), me) };
}
#[cfg(not(windows))]
pub fn park_test_windows() {}
