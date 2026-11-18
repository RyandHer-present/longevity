//! The FPS / shaders switch: two saved setups per instance (render distance, shaders, memory...)
//! written into the game's own settings files right before the game starts.

use super::prism;
use super::util::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Setup {
    pub render_distance: i64,
    pub simulation_distance: i64,
    pub max_fps: i64,
    pub shaders: bool,
    pub shader_pack: String,
    pub clouds: bool,
    pub particles: i64,
    pub memory_mb: i64,
    pub vsync: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Profiles {
    pub active: Option<String>,
    pub fps: Option<Setup>,
    pub shaders: Option<Setup>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PerfState {
    pub active: Option<String>,
    pub fps: Setup,
    pub shaders: Setup,
    pub current: Setup,
    pub shader_packs: Vec<String>,
    pub has_iris: bool,
    pub ram_mb: i64,
}

fn path(inst: &str) -> PathBuf {
    data_dir().join("profiles").join(format!("{inst}.json"))
}

fn options(mc: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(t) = std::fs::read_to_string(mc.join("options.txt")) {
        for l in t.lines() {
            if let Some((k, v)) = l.split_once(':') {
                out.insert(k.to_string(), v.to_string());
            }
        }
    }
    out
}

fn iris(mc: &Path) -> HashMap<String, String> {
    prism::read_cfg(&mc.join("config").join("iris.properties"))
}

pub fn shader_packs(mc: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(mc.join("shaderpacks"))
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".zip") || !n.contains('.')).collect())
        .unwrap_or_default();
    v.sort();
    v
}

pub fn current(inst: &prism::Instance) -> Setup {
    let mc = PathBuf::from(&inst.mc_dir);
    let o = options(&mc);
    let ir = iris(&mc);
    let num = |k: &str, d: i64| o.get(k).and_then(|v| v.trim_matches('"').parse::<f64>().ok()).map(|v| v as i64).unwrap_or(d);
    Setup {
        render_distance: num("renderDistance", 12),
        simulation_distance: num("simulationDistance", 12),
        max_fps: num("maxFps", 120),
        shaders: ir.get("enableShaders").map(|v| v == "true").unwrap_or(false),
        shader_pack: ir.get("shaderPack").cloned().unwrap_or_default(),
        clouds: o.get("renderClouds").map(|v| v.trim_matches('"') != "false").unwrap_or(true),
        particles: num("particles", 0),
        memory_mb: inst.max_mem,
        vsync: o.get("enableVsync").map(|v| v == "true").unwrap_or(false),
    }
}

pub fn total_ram_mb() -> i64 {
    let mut s = sysinfo::System::new();
    s.refresh_memory();
    (s.total_memory() / 1024 / 1024) as i64
}

pub fn state(inst: &prism::Instance) -> PerfState {
    let p: Profiles = read_json(&path(&inst.id));
    let cur = current(inst);
    let mc = PathBuf::from(&inst.mc_dir);
    let packs = shader_packs(&mc);
    let pack = if !cur.shader_pack.is_empty() { cur.shader_pack.clone() } else { packs.first().cloned().unwrap_or_default() };
    let fps = p.fps.clone().unwrap_or_else(|| Setup {
        render_distance: cur.render_distance.min(16),
        simulation_distance: cur.simulation_distance.min(8),
        max_fps: 260,
        shaders: false,
        shader_pack: pack.clone(),
        clouds: false,
        particles: 2,
        memory_mb: cur.memory_mb,
        vsync: false,
    });
    let shaders = p.shaders.clone().unwrap_or_else(|| Setup {
        render_distance: cur.render_distance.min(16).max(10),
        simulation_distance: cur.simulation_distance,
        max_fps: cur.max_fps.min(144).max(60),
        shaders: true,
        shader_pack: pack,
        clouds: true,
        particles: 0,
        memory_mb: cur.memory_mb.max(6144),
        vsync: false,
    });
    let active = p.active.clone().or_else(|| {
        if cur == fps {
            Some("fps".into())
        } else if cur == shaders {
            Some("shaders".into())
        } else {
            None
        }
    });
    PerfState { active, fps, shaders, current: cur, shader_packs: packs, has_iris: mc.join("config").join("iris.properties").is_file() || has_mod(&mc, "iris"), ram_mb: total_ram_mb() }
}

fn has_mod(mc: &Path, needle: &str) -> bool {
    std::fs::read_dir(mc.join("mods")).map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase().contains(needle))).unwrap_or(false)
}

pub fn save(inst: &str, which: &str, setup: Setup) -> anyhow::Result<()> {
    let mut p: Profiles = read_json(&path(inst));
    match which {
        "fps" => p.fps = Some(setup),
        "shaders" => p.shaders = Some(setup),
        _ => anyhow::bail!("unknown setup"),
    }
    write_json(&path(inst), &p)
}

pub fn set_active(inst: &str, which: Option<String>) -> anyhow::Result<()> {
    let mut p: Profiles = read_json(&path(inst));
    p.active = which;
    write_json(&path(inst), &p)
}

fn set_lines(file: &Path, sep: char, keys: &[(&str, String)]) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    for (k, v) in keys {
        let prefix = format!("{k}{sep}");
        match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            Some(l) => *l = format!("{k}{sep}{v}"),
            None => lines.push(format!("{k}{sep}{v}")),
        }
    }
    let mut s = lines.join("\n");
    s.push('\n');
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(file, s)?;
    Ok(())
}

/// Write the active setup into options.txt, Iris's config and Prism's memory setting.
/// Only call when the game isn't running (the game rewrites options.txt when it closes).
pub fn apply(inst: &prism::Instance) -> anyhow::Result<Option<String>> {
    let st = state(inst);
    let Some(active) = st.active.clone() else { return Ok(None) };
    let s = if active == "fps" { st.fps } else { st.shaders };
    let mc = PathBuf::from(&inst.mc_dir);
    if mc.join("options.txt").is_file() {
        set_lines(
            &mc.join("options.txt"),
            ':',
            &[
                ("renderDistance", s.render_distance.to_string()),
                ("simulationDistance", s.simulation_distance.to_string()),
                ("maxFps", s.max_fps.to_string()),
                ("renderClouds", if s.clouds { "\"true\"".into() } else { "\"false\"".into() }),
                ("particles", s.particles.to_string()),
                ("enableVsync", s.vsync.to_string()),
            ],
        )?;
    }
    if st.has_iris {
        let mut keys = vec![("enableShaders", s.shaders.to_string())];
        if !s.shader_pack.is_empty() {
            keys.push(("shaderPack", s.shader_pack.clone()));
        }
        set_lines(&mc.join("config").join("iris.properties"), '=', &keys)?;
    }
    if s.memory_mb >= 1024 && s.memory_mb != inst.max_mem {
        let cfg = PathBuf::from(&inst.dir).join("instance.cfg");
        let min = inst.min_mem.min(s.memory_mb);
        prism::write_cfg_keys(&cfg, &[("OverrideMemory", "true".into()), ("MaxMemAlloc", s.memory_mb.to_string()), ("MinMemAlloc", min.to_string())])?;
    }
    Ok(Some(active))
}

pub fn raise_memory(inst: &prism::Instance) -> anyhow::Result<i64> {
    let ram = total_ram_mb();
    let target = (inst.max_mem + 2048).min((ram * 6 / 10).max(4096)).max(inst.max_mem);
    let cfg = PathBuf::from(&inst.dir).join("instance.cfg");
    prism::write_cfg_keys(&cfg, &[("OverrideMemory", "true".into()), ("MaxMemAlloc", target.to_string()), ("MinMemAlloc", inst.min_mem.min(target).to_string())])?;
    let mut p: Profiles = read_json(&path(&inst.id));
    for s in [&mut p.fps, &mut p.shaders].into_iter().flatten() {
        if s.memory_mb < target {
            s.memory_mb = target;
        }
    }
    write_json(&path(&inst.id), &p)?;
    Ok(target)
}

/// A freshly installed shader pack becomes the one Shaders mode uses.
pub fn use_shader_pack(inst: &prism::Instance, pack: &str) -> anyhow::Result<()> {
    let st = state(inst);
    let mut p: Profiles = read_json(&path(&inst.id));
    let mut s = p.shaders.clone().unwrap_or(st.shaders);
    s.shader_pack = pack.to_string();
    s.shaders = true;
    p.shaders = Some(s);
    if p.fps.is_none() {
        p.fps = Some(st.fps);
    }
    write_json(&path(&inst.id), &p)?;
    if p.active.as_deref() == Some("shaders") && !prism::running().contains_key(&inst.id) {
        let _ = apply(&prism::instance(&inst.id).unwrap_or_else(|| inst.clone()));
    }
    Ok(())
}

/// Memory set from the instance settings: Prism's setting and both modes agree on it.
pub fn set_memory(inst: &prism::Instance, mb: i64) -> anyhow::Result<()> {
    let mb = mb.clamp(1024, total_ram_mb().max(2048));
    let cfg = PathBuf::from(&inst.dir).join("instance.cfg");
    prism::write_cfg_keys(&cfg, &[("OverrideMemory", "true".into()), ("MaxMemAlloc", mb.to_string()), ("MinMemAlloc", inst.min_mem.clamp(256, mb).to_string())])?;
    let st = state(inst);
    let mut p: Profiles = read_json(&path(&inst.id));
    let mut fps = p.fps.clone().unwrap_or(st.fps);
    let mut sh = p.shaders.clone().unwrap_or(st.shaders);
    fps.memory_mb = mb;
    sh.memory_mb = mb;
    p.fps = Some(fps);
    p.shaders = Some(sh);
    write_json(&path(&inst.id), &p)
}
