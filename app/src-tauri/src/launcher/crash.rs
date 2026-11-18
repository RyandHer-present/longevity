//! Crash explainer: reads the newest crash report or a failed log and says, in plain words,
//! what broke, which mod did it, and what to do about it.

use super::mods::InstalledMod;
use super::util::*;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, Default)]
pub struct Culprit {
    pub mod_id: String,
    pub name: String,
    pub file: Option<String>,
    pub why: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Action {
    pub kind: String,
    pub label: String,
    pub target: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Report {
    pub id: String,
    pub time: i64,
    pub source: String,
    pub title: String,
    pub detail: String,
    pub culprits: Vec<Culprit>,
    pub steps: Vec<String>,
    pub actions: Vec<Action>,
    pub exception: String,
    pub excerpt: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct CrashItem {
    pub id: String,
    pub time: i64,
    pub title: String,
    pub source: String,
}

fn crash_files(mc: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(mc.join("crash-reports"))
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "txt").unwrap_or(false)).collect())
        .unwrap_or_default();
    v.sort_by_key(|p| std::cmp::Reverse(mtime_ms(p)));
    v
}

fn log_failed(text: &str) -> bool {
    text.contains("Incompatible mods found!")
        || text.contains("Mod resolution failed")
        || text.contains("Could not execute entrypoint")
        || text.contains("java.lang.OutOfMemoryError")
}

pub fn history(mc: &Path, mods: &[InstalledMod]) -> Vec<CrashItem> {
    let mut out = vec![];
    let log = mc.join("logs").join("latest.log");
    if let Ok(t) = std::fs::read_to_string(&log) {
        if log_failed(&t) {
            let r = analyze_text(&t, "log", mods);
            out.push(CrashItem { id: "latest.log".into(), time: mtime_ms(&log), title: r.title, source: "log".into() });
        }
    }
    for p in crash_files(mc).into_iter().take(15) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let r = analyze_text(&t, "crash", mods);
            out.push(CrashItem { id: p.file_name().unwrap().to_string_lossy().to_string(), time: mtime_ms(&p), title: r.title, source: "crash".into() });
        }
    }
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

pub fn report(mc: &Path, id: &str, mods: &[InstalledMod]) -> Option<Report> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return None;
    }
    let (p, source) = if id == "latest.log" { (mc.join("logs").join("latest.log"), "log") } else { (mc.join("crash-reports").join(id), "crash") };
    let t = std::fs::read_to_string(&p).ok()?;
    let mut r = analyze_text(&t, source, mods);
    r.id = id.to_string();
    r.time = mtime_ms(&p);
    r.path = p.to_string_lossy().to_string();
    Some(r)
}

/// The newest problem since `since_ms` (a crash report, or a log that failed to start).
pub fn newest_since(mc: &Path, since_ms: i64, mods: &[InstalledMod]) -> Option<Report> {
    history(mc, mods).into_iter().find(|c| c.time >= since_ms).and_then(|c| report(mc, &c.id, mods))
}

fn find_mod<'a>(mods: &'a [InstalledMod], id: &str) -> Option<&'a InstalledMod> {
    let id = id.to_lowercase();
    mods.iter().find(|m| m.meta.id.to_lowercase() == id).or_else(|| mods.iter().find(|m| m.meta.mixins.iter().any(|x| x.to_lowercase().starts_with(&format!("{id}.")))))
}

fn mod_for_package<'a>(mods: &'a [InstalledMod], class: &str) -> Option<&'a InstalledMod> {
    let class = class.replace('/', ".");
    let mut best: Option<(&InstalledMod, usize)> = None;
    for m in mods {
        for p in &m.meta.packages {
            if class.starts_with(&format!("{p}.")) && best.map(|b| p.len() > b.1).unwrap_or(true) {
                best = Some((m, p.len()));
            }
        }
    }
    best.map(|b| b.0)
}

fn known_library(class: &str) -> Option<(&'static str, &'static str)> {
    let c = class.replace('/', ".");
    let table: [(&str, &str, &str); 12] = [
        ("com.natamus.collective", "collective", "Collective"),
        ("com.natamus.", "collective", "Collective"),
        ("me.shedaniel.clothconfig", "cloth-config", "Cloth Config API"),
        ("me.shedaniel.architectury", "architectury-api", "Architectury API"),
        ("dev.architectury", "architectury-api", "Architectury API"),
        ("com.terraformersmc.modmenu", "modmenu", "Mod Menu"),
        ("net.fabricmc.fabric", "fabric-api", "Fabric API"),
        ("dev.isxander.yacl", "yacl", "YetAnotherConfigLib"),
        ("eu.midnightdust.lib", "midnightlib", "MidnightLib"),
        ("fuzs.puzzleslib", "puzzles-lib", "Puzzles Lib"),
        ("software.bernie.geckolib", "geckolib", "GeckoLib"),
        ("org.ladysnake.cca", "cardinal-components-api", "Cardinal Components API"),
    ];
    table.iter().find(|(p, _, _)| c.starts_with(p)).map(|(_, id, name)| (*id, *name))
}

fn culprit_of(m: &InstalledMod, why: &str) -> Culprit {
    Culprit { mod_id: m.meta.id.clone(), name: m.meta.name.clone(), file: Some(m.file.clone()), why: why.to_string() }
}

fn push_unique(v: &mut Vec<Culprit>, c: Culprit) {
    if !v.iter().any(|x| x.mod_id == c.mod_id && !c.mod_id.is_empty()) {
        v.push(c);
    }
}

pub fn analyze_text(text: &str, source: &str, mods: &[InstalledMod]) -> Report {
    let mut r = Report { source: source.into(), ..Default::default() };
    let lines: Vec<&str> = text.lines().collect();
    r.excerpt = lines.iter().take(60).cloned().collect::<Vec<_>>().join("\n");
    let description = lines.iter().find_map(|l| l.strip_prefix("Description: ")).unwrap_or("").to_string();
    let exception = lines
        .iter()
        .skip_while(|l| !l.starts_with("Description: "))
        .skip(1)
        .find(|l| !l.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    r.exception = exception.clone();

    // 1. Fabric refused to start: incompatible or missing mods
    if let Some(i) = lines.iter().position(|l| l.contains("Incompatible mods found!") || l.contains("Mod resolution failed")) {
        r.title = "Some mods don't fit together".into();
        r.detail = "Fabric stopped before the game opened, because some mods need a different Minecraft version or need other mods that aren't installed.".into();
        let re_replace = regex::Regex::new(r"Replace mod '([^']+)' \(([^)]+)\) (\S+) with any version that is compatible with").unwrap();
        let re_install = regex::Regex::new(r"Install mod '?([^'(]+)'? \(([^)]+)\)").unwrap();
        let re_remove = regex::Regex::new(r"Remove mod '([^']+)' \(([^)]+)\)").unwrap();
        let re_needs = regex::Regex::new(r"Mod '([^']+)' \(([^)]+)\) \S+ requires (.+?) of (?:mod )?'([^']+)' \(([^)]+)\)(?:, which is missing|, but only the wrong version is present: (\S+?))?!?$").unwrap();
        for l in lines.iter().skip(i).take(80) {
            let l = l.trim().trim_start_matches("- ").trim();
            if let Some(c) = re_replace.captures(l) {
                let (name, id) = (c[1].to_string(), c[2].to_string());
                r.steps.push(format!("Update {name} to a version made for this Minecraft version, or turn it off."));
                let cul = find_mod(mods, &id).map(|m| culprit_of(m, "made for a different Minecraft version")).unwrap_or(Culprit { mod_id: id.clone(), name: name.clone(), file: None, why: "made for a different Minecraft version".into() });
                push_unique(&mut r.culprits, cul);
            } else if let Some(c) = re_install.captures(l) {
                let (name, id) = (c[1].trim().to_string(), c[2].to_string());
                r.steps.push(format!("Install {name}. Another mod needs it."));
                r.actions.push(Action { kind: "store".into(), label: format!("Find {name} in the store"), target: id });
            } else if let Some(c) = re_remove.captures(l) {
                let (name, id) = (c[1].to_string(), c[2].to_string());
                r.steps.push(format!("Turn off {name}."));
                if let Some(m) = find_mod(mods, &id) {
                    push_unique(&mut r.culprits, culprit_of(m, "Fabric says to remove it"));
                }
            } else if let Some(c) = re_needs.captures(l) {
                let (name, id, dep_name, dep_id) = (c[1].to_string(), c[2].to_string(), c[4].to_string(), c[5].to_string());
                let why = if dep_id == "minecraft" {
                    format!("needs Minecraft {}", c[3].replace("any version between", "").replace("version", "").trim())
                } else if l.contains("which is missing") {
                    format!("needs {dep_name}, which isn't installed")
                } else {
                    format!("needs a different version of {dep_name}")
                };
                let cul = find_mod(mods, &id).map(|m| culprit_of(m, &why)).unwrap_or(Culprit { mod_id: id.clone(), name: name.clone(), file: None, why: why.clone() });
                push_unique(&mut r.culprits, cul);
                if l.contains("which is missing") && dep_id != "minecraft" && !r.actions.iter().any(|a| a.target == dep_id) {
                    r.actions.push(Action { kind: "store".into(), label: format!("Find {dep_name} in the store"), target: dep_id });
                }
            }
        }
        r.steps.dedup();
        finish_actions(&mut r);
        return r;
    }

    // 2. Out of memory
    if text.contains("java.lang.OutOfMemoryError") {
        r.title = "Minecraft ran out of memory".into();
        r.detail = "The game used up all the memory it was given. Giving it more usually fixes this, especially with shaders or a big render distance.".into();
        r.steps.push("Give the instance more memory, then play again.".into());
        r.actions.push(Action { kind: "memory".into(), label: "Give it more memory".into(), target: String::new() });
        return r;
    }

    // 3. Java too old
    if text.contains("UnsupportedClassVersionError") {
        r.title = "This needs a newer Java".into();
        r.detail = "A mod or the game was built for a newer Java than the one this instance uses.".into();
        r.steps.push("In Prism, let it pick Java automatically for this instance.".into());
        return r;
    }

    // 4. Mixin failures name the mod outright
    let re_mixin = regex::Regex::new(r"Mixin \[([\w.\-]+):[\w.$]+ from mod ([\w\-]+)\]").unwrap();
    for c in re_mixin.captures_iter(text) {
        let id = c[2].to_string();
        if let Some(m) = find_mod(mods, &id) {
            push_unique(&mut r.culprits, culprit_of(m, "its changes to the game failed to apply"));
        } else {
            push_unique(&mut r.culprits, Culprit { mod_id: id.clone(), name: id.clone(), file: None, why: "its changes to the game failed to apply".into() });
        }
    }
    if !r.culprits.is_empty() {
        r.title = format!("{} doesn't work with this version", r.culprits[0].name);
        r.detail = format!(
            "{} tried to change part of Minecraft that isn't there or works differently in this version. That usually means the mod is out of date, or another mod changes the same thing.",
            r.culprits[0].name
        );
        r.steps.push(format!("Check for an update to {}.", r.culprits[0].name));
        r.steps.push(format!("If there's no update, turn {} off.", r.culprits[0].name));
        finish_actions(&mut r);
        return r;
    }

    // 5. A mod's class is missing: a dependency isn't installed
    let re_cnf = regex::Regex::new(r"(?:NoClassDefFoundError|ClassNotFoundException):? ([\w./$]+)").unwrap();
    if let Some(c) = re_cnf.captures(text) {
        let class = c[1].replace('/', ".");
        if !class.starts_with("net.minecraft") && !class.starts_with("java") {
            if let Some((id, name)) = known_library(&class) {
                r.title = format!("{name} is missing");
                r.detail = format!("A mod needs {name} to run, and it isn't installed (or it's the wrong version).");
                r.steps.push(format!("Install {name} from the store."));
                r.actions.push(Action { kind: "store".into(), label: format!("Find {name} in the store"), target: id.into() });
                if let Some(m) = mod_for_package(mods, &class) {
                    push_unique(&mut r.culprits, culprit_of(m, &format!("is part of the {name} family")));
                }
                finish_actions(&mut r);
                return r;
            }
            if let Some(m) = mod_for_package(mods, &class) {
                r.title = format!("{} is missing a piece", m.meta.name);
                r.detail = format!("{} couldn't find part of itself or a mod it relies on. Installing a matching version usually fixes it.", m.meta.name);
                push_unique(&mut r.culprits, culprit_of(m, "a part it needs couldn't be found"));
            } else {
                let pkg = class.split('.').take(3).collect::<Vec<_>>().join(".");
                r.title = "A mod needs another mod that isn't installed".into();
                r.detail = format!("Something from {pkg} is missing. That's usually a library mod that another mod depends on.");
                r.steps.push("Look at the mod's page for the mods it needs, and install them.".into());
            }
            finish_actions(&mut r);
            return r;
        }
    }

    // 6. Explicit blame in the message
    let re_fault = regex::Regex::new(r"(?i)fault of the ([\w \-']+?) mod").unwrap();
    if let Some(c) = re_fault.captures(text) {
        let name = c[1].trim().to_string();
        let m = mods.iter().find(|m| m.meta.name.eq_ignore_ascii_case(&name) || m.meta.id.eq_ignore_ascii_case(&name.replace(' ', "")) || m.meta.id.eq_ignore_ascii_case(&name.replace(' ', "-")));
        r.title = format!("{name} caused the crash");
        r.detail = format!("The crash report itself says this is very likely the fault of {name}. Updating it or turning it off fixes it.");
        if let Some(m) = m {
            push_unique(&mut r.culprits, culprit_of(m, "named in the crash report"));
        } else {
            push_unique(&mut r.culprits, Culprit { mod_id: String::new(), name: name.clone(), file: None, why: "named in the crash report".into() });
        }
        finish_actions(&mut r);
        return r;
    }

    // 7. Mixin handler frames carry the mod id: handler$abc000$modid$name, wrapOperation$egk000$modid$name
    let re_handler = regex::Regex::new(r"\$[a-z]{3}\d{3}\$([a-z0-9_\-]+)\$").unwrap();
    for l in lines.iter().take(80) {
        if let Some(c) = re_handler.captures(l) {
            if let Some(m) = find_mod(mods, &c[1]) {
                push_unique(&mut r.culprits, culprit_of(m, "its code is in the middle of the crash"));
            }
        }
    }
    // 8. The first stack frame that belongs to a mod
    let re_frame = regex::Regex::new(r"^\s*at (?:[\w.]+//)?([\w.$]+)\.[\w$<>]+\(").unwrap();
    for l in lines.iter().take(120) {
        if let Some(c) = re_frame.captures(l) {
            let cls = &c[1];
            if cls.starts_with("java.") || cls.starts_with("jdk.") || cls.starts_with("net.minecraft") || cls.starts_with("com.mojang") || cls.starts_with("net.fabricmc.loader") || cls.starts_with("org.prismlauncher") || cls.starts_with("sun.") || cls.starts_with("org.spongepowered") || cls.starts_with("com.llamalad7") {
                continue;
            }
            if let Some(m) = mod_for_package(mods, cls) {
                push_unique(&mut r.culprits, culprit_of(m, "its code is where the crash happened"));
                break;
            }
        }
    }
    let what = match description.as_str() {
        "Initializing game" => "while the game was starting up",
        "Ticking entity" => "while updating a mob or entity in the world",
        "Ticking block entity" => "while updating a block like a chest or furnace",
        "Exception in server tick loop" => "inside the world's game loop",
        "Rendering screen" | "Rendering overlay" => "while drawing the screen",
        "Unexpected error" => "out of nowhere during play",
        "Watching Server" | "Client shutdown from post-main" => "while closing the game",
        _ => "while playing",
    };
    let short_ex = exception.split(':').next().unwrap_or("").rsplit('.').next().unwrap_or("").to_string();
    if let Some(c) = r.culprits.first() {
        r.title = format!("{} crashed the game", c.name);
        r.detail = format!("Minecraft crashed {what}, and {} is the most likely cause. An update often fixes it; if not, turning it off will.", c.name);
        r.steps.push(format!("Check for an update to {}.", c.name));
        r.steps.push(format!("If it keeps happening, turn {} off.", c.name));
    } else {
        r.title = format!("Minecraft crashed {what}");
        r.detail = if short_ex.is_empty() {
            "No single mod is to blame in the report. If this started after a change, rolling back your mods is the quickest fix.".into()
        } else {
            format!("The error was a {short_ex}, and no single mod is to blame in the report. If this started after a change, rolling back your mods is the quickest fix.")
        };
        r.steps.push("If it started after you added or updated mods, roll back to the last backup.".into());
    }
    if text.contains("EXCEPTION_ACCESS_VIOLATION") || text.to_lowercase().contains("opengl") {
        r.steps.push("This looks graphics-related. Try the FPS setup (shaders off) or update your graphics driver.".into());
        r.actions.push(Action { kind: "fps".into(), label: "Switch to the FPS setup".into(), target: String::new() });
    }
    finish_actions(&mut r);
    r
}

fn finish_actions(r: &mut Report) {
    let mut acts = vec![];
    for c in &r.culprits {
        if let Some(f) = &c.file {
            acts.push(Action { kind: "disable".into(), label: format!("Turn off {}", c.name), target: f.clone() });
        }
    }
    if !r.culprits.is_empty() {
        acts.push(Action { kind: "updates".into(), label: "Check for updates".into(), target: String::new() });
    }
    acts.push(Action { kind: "rollback".into(), label: "Roll back mods".into(), target: String::new() });
    for a in acts {
        if !r.actions.iter().any(|x| x.kind == a.kind && x.target == a.target) {
            r.actions.push(a);
        }
    }
}
