//! Reads an instance's Minecraft logs (latest.log + dated .log.gz) into play sessions and events.

use crate::events::Event;
use regex::Regex;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize)]
pub struct Session {
    pub start: i64,
    pub end: i64,
    pub level: String,
    pub login_pos: Option<[f64; 3]>,
    pub player: Option<String>,
    pub events: Vec<Event>,
    pub file: String,
}

/// Local timezone offset in minutes (east of UTC), from the system via `chrono`-free math:
/// we compare the file's modification time with the last log line when possible; otherwise assume
/// the offset Windows reports through the TZ environment (falls back to 0).
fn local_offset_ms() -> i64 {
    static OFF: OnceLock<i64> = OnceLock::new();
    *OFF.get_or_init(|| {
        // Use PowerShell-free approach: GetTimeZoneInformation through the `tzutil`-less registry is overkill;
        // Windows exposes the bias via the environment only in some shells, so read it from the registry.
        #[cfg(windows)]
        {
            if let Ok(out) = std::process::Command::new("reg")
                .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation", "/v", "ActiveTimeBias"])
                .creation_flags_hidden()
                .output()
            {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(hex) = s.split_whitespace().find(|w| w.starts_with("0x")) {
                    if let Ok(v) = u32::from_str_radix(hex.trim_start_matches("0x"), 16) {
                        let bias_min = v as i32; // minutes, UTC = local + bias
                        return -(bias_min as i64) * 60_000;
                    }
                }
            }
        }
        0
    })
}

trait HiddenCmd {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}
impl HiddenCmd for std::process::Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000);
        }
        self
    }
}

/// Days since 1970-01-01 for a civil date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Unix ms of local midnight for a date.
fn local_midnight_ms(y: i64, m: i64, d: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400_000 - local_offset_ms()
}

fn civil_from_ms(ms: i64) -> (i64, i64, i64) {
    let z = (ms + local_offset_ms()).div_euclid(86_400_000) + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

struct Rx {
    line: Regex,
    start: Regex,
    level: Regex,
    login: Regex,
    adv: Regex,
    chat: Regex,
    named_death: Regex,
    stop: Regex,
}

fn rx() -> &'static Rx {
    static R: OnceLock<Rx> = OnceLock::new();
    R.get_or_init(|| Rx {
        line: Regex::new(r"^\[(\d\d):(\d\d):(\d\d)\] \[([^\]]+)/(\w+)\]: (.*)$").unwrap(),
        start: Regex::new(r"Starting integrated minecraft server version").unwrap(),
        level: Regex::new(r"ServerLevel\[(.+?)\]").unwrap(),
        login: Regex::new(r"^(\w+)\[[^\]]*\] logged in with entity id \d+ at \(([-0-9.E]+), ([-0-9.E]+), ([-0-9.E]+)\)").unwrap(),
        adv: Regex::new(r"^(?:\[System\] \[CHAT\] |System chat: )?(\w+) has (made the advancement|completed the challenge|reached the goal) \[(.+)\]$").unwrap(),
        chat: Regex::new(r"^(?:\[System\] \[CHAT\] |\[Not Secure\] )?<(\w+)> (.*)$").unwrap(),
        named_death: Regex::new(r"^(?:Villager|Named entity) .*?\['([^']+)'/\d+, l='ServerLevel\[(.+?)\]', x=([-0-9.]+), y=([-0-9.]+), z=([-0-9.]+)\] died, message: '(.+)'$").unwrap(),
        stop: Regex::new(r"Stopping server|Stopping!|Saving worlds").unwrap(),
    })
}

/// All log files of an instance with the local date they start on, oldest first.
pub fn log_files(logs_dir: &Path) -> Vec<(PathBuf, (i64, i64, i64))> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(logs_dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".log.gz") {
            let parts: Vec<&str> = stem.split('-').collect();
            if parts.len() >= 3 {
                if let (Ok(y), Ok(m), Ok(d)) = (parts[0].parse(), parts[1].parse(), parts[2].parse()) {
                    out.push((e.path(), (y, m, d)));
                }
            }
        } else if name == "latest.log" {
            // the date latest.log started: its modification time minus the span of its lines is unknown,
            // so use the modification date (sessions rarely cross midnight; handled below).
            if let Ok(meta) = e.metadata() {
                if let Ok(mt) = meta.modified() {
                    let ms = mt.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                    out.push((e.path(), civil_from_ms(ms)));
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let la = a.0.file_name().map(|n| n == "latest.log").unwrap_or(false);
        let lb = b.0.file_name().map(|n| n == "latest.log").unwrap_or(false);
        la.cmp(&lb).then(a.1.cmp(&b.1)).then(natural(&a.0).cmp(&natural(&b.0)))
    });
    out
}

fn natural(p: &Path) -> i64 {
    p.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.trim_end_matches(".log.gz").rsplit('-').next().map(|s| s.to_string()))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn read_text(p: &Path) -> Option<String> {
    let raw = std::fs::read(p).ok()?;
    if p.extension().map(|e| e == "gz").unwrap_or(false) {
        let mut s = Vec::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut s).ok()?;
        Some(String::from_utf8_lossy(&s).to_string())
    } else {
        Some(String::from_utf8_lossy(&raw).to_string())
    }
}

/// Death message templates (from en_us.json "death.*"), e.g. "{0} was slain by {1}".
pub type DeathTemplates = Vec<String>;

fn match_death(msg: &str, player: &str, templates: &DeathTemplates) -> Option<String> {
    if !msg.starts_with(player) {
        return None;
    }
    for t in templates {
        let Some(rest_t) = t.strip_prefix("{0}") else { continue };
        let rest = &msg[player.len()..];
        // turn the template into a loose matcher: literal pieces in order
        let pieces: Vec<&str> = rest_t.split(|c| c == '{' || c == '}').enumerate().filter(|(i, _)| i % 2 == 0).map(|(_, s)| s).collect();
        let mut pos = 0usize;
        let mut ok = true;
        for (i, p) in pieces.iter().enumerate() {
            if p.is_empty() {
                continue;
            }
            match rest[pos..].find(p) {
                Some(f) if i > 0 || f == 0 => pos += f + p.len(),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && (pieces.last().map(|l| l.is_empty()).unwrap_or(true) || pos == rest.len()) {
            return Some(msg.to_string());
        }
    }
    None
}

/// Parse every log in `logs_dir` into sessions (one per integrated-server start).
pub fn parse_sessions(logs_dir: &Path, death_templates: &DeathTemplates) -> Vec<Session> {
    let r = rx();
    let mut sessions: Vec<Session> = Vec::new();
    for (path, (y, m, d)) in log_files(logs_dir) {
        let Some(text) = read_text(&path) else { continue };
        let mut day_base = local_midnight_ms(y, m, d);
        let mut last_secs: i64 = -1;
        let mut cur: Option<Session> = None;
        let mut player: Option<String> = None;
        let fname = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // latest.log: modification date is the END date; if the first line's time is later than the last line's, the log crossed midnight
        let is_latest = fname == "latest.log";
        if is_latest {
            let first = text.lines().find_map(|l| r.line.captures(l).map(|c| c[1].parse::<i64>().unwrap_or(0) * 3600 + c[2].parse::<i64>().unwrap_or(0) * 60));
            let last = text.lines().rev().find_map(|l| r.line.captures(l).map(|c| c[1].parse::<i64>().unwrap_or(0) * 3600 + c[2].parse::<i64>().unwrap_or(0) * 60));
            if let (Some(f), Some(l)) = (first, last) {
                if f > l {
                    day_base -= 86_400_000;
                }
            }
        }
        for line in text.lines() {
            let Some(c) = r.line.captures(line) else { continue };
            let secs = c[1].parse::<i64>().unwrap_or(0) * 3600 + c[2].parse::<i64>().unwrap_or(0) * 60 + c[3].parse::<i64>().unwrap_or(0);
            if last_secs >= 0 && secs + 3600 < last_secs {
                day_base += 86_400_000; // crossed midnight
            }
            last_secs = secs;
            let t = day_base + secs * 1000;
            let thread = &c[4];
            let msg = &c[6];
            if r.start.is_match(msg) {
                if let Some(s) = cur.take() {
                    sessions.push(s);
                }
                cur = Some(Session { start: t, end: t, level: String::new(), login_pos: None, player: None, events: vec![], file: fname.clone() });
                continue;
            }
            let Some(s) = cur.as_mut() else { continue };
            s.end = t;
            if s.level.is_empty() {
                if let Some(l) = r.level.captures(msg) {
                    s.level = l[1].to_string();
                }
            }
            if let Some(l) = r.login.captures(msg) {
                let p = [l[2].parse().unwrap_or(0.0), l[3].parse().unwrap_or(0.0), l[4].parse().unwrap_or(0.0)];
                if s.login_pos.is_none() {
                    s.login_pos = Some(p);
                }
                player = Some(l[1].to_string());
                s.player = player.clone();
                continue;
            }
            if thread.starts_with("Server thread") {
                if let Some(nd) = r.named_death.captures(msg) {
                    s.events.push(Event {
                        t,
                        day: None,
                        kind: "villager_death".into(),
                        title: nd[6].to_string(),
                        detail: nd[1].to_string(),
                        pos: Some([nd[3].parse().unwrap_or(0.0), nd[4].parse().unwrap_or(0.0), nd[5].parse().unwrap_or(0.0)]),
                        dim: None,
                        source: "log".into(),
                    });
                    continue;
                }
                if r.stop.is_match(msg) && msg.starts_with("Stopping server") {
                    s.end = t;
                }
            }
            // advancements and deaths appear in the client chat log
            let chat_msg = msg.strip_prefix("[System] [CHAT] ").or_else(|| msg.strip_prefix("System chat: "));
            if let Some(cm) = chat_msg {
                if let Some(a) = r.adv.captures(cm) {
                    let kind = match &a[2] {
                        "completed the challenge" => "challenge",
                        "reached the goal" => "goal",
                        _ => "advancement",
                    };
                    let ev = Event { t, day: None, kind: "advancement".into(), title: a[3].to_string(), detail: kind.into(), pos: None, dim: None, source: "log".into() };
                    if !s.events.iter().any(|e| e.kind == ev.kind && e.title == ev.title) {
                        s.events.push(ev);
                    }
                    continue;
                }
                if cm == "Respawn point set" {
                    if !s.events.iter().any(|e| e.kind == "respawn_set" && (t - e.t).abs() < 60_000) {
                        s.events.push(Event { t, day: None, kind: "respawn_set".into(), title: "Respawn point set".into(), detail: String::new(), pos: None, dim: None, source: "log".into() });
                    }
                    continue;
                }
                if let Some(p) = &player {
                    if let Some(dm) = match_death(cm, p, death_templates) {
                        if !s.events.iter().any(|e| e.kind == "death" && (t - e.t).abs() < 3000) {
                            s.events.push(Event { t, day: None, kind: "death".into(), title: dm, detail: String::new(), pos: None, dim: None, source: "log".into() });
                        }
                        continue;
                    }
                }
                if let Some(ch) = r.chat.captures(cm) {
                    s.events.push(Event { t, day: None, kind: "chat".into(), title: ch[2].to_string(), detail: ch[1].to_string(), pos: None, dim: None, source: "log".into() });
                }
            }
        }
        if let Some(s) = cur.take() {
            sessions.push(s);
        }
    }
    sessions.retain(|s| !s.level.is_empty());
    sessions
}
