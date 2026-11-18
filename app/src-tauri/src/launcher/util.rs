use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

pub type R<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn data_dir() -> PathBuf {
    let d = std::env::var("LONGEVITY_LAUNCHER_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(".")).join("Longevity").join("launcher")
    });
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn mtime_ms(p: &std::path::Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn http() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent(concat!("Longevity/", env!("CARGO_PKG_VERSION"), " (personal Minecraft hub)"))
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("http client")
    })
}

pub fn get_json(url: &str) -> anyhow::Result<serde_json::Value> {
    let r = http().get(url).send()?;
    if !r.status().is_success() {
        anyhow::bail!("{} returned {}", short_host(url), r.status());
    }
    Ok(r.json()?)
}

pub fn post_json(url: &str, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let r = http().post(url).json(body).send()?;
    if !r.status().is_success() {
        anyhow::bail!("{} returned {}", short_host(url), r.status());
    }
    Ok(r.json()?)
}

pub fn get_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    let r = http().get(url).send()?;
    if !r.status().is_success() {
        anyhow::bail!("{} returned {}", short_host(url), r.status());
    }
    Ok(r.bytes()?.to_vec())
}

fn short_host(url: &str) -> String {
    url.split("//").nth(1).and_then(|s| s.split('/').next()).unwrap_or(url).to_string()
}

pub fn sha1_hex(b: &[u8]) -> String {
    use sha1::Digest;
    let mut h = sha1::Sha1::new();
    h.update(b);
    hex(&h.finalize())
}

pub fn sha512_hex(b: &[u8]) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha512::new();
    h.update(b);
    hex(&h.finalize())
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn fnv(s: &str) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

pub fn read_json<T: serde::de::DeserializeOwned + Default>(p: &std::path::Path) -> T {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn write_json<T: serde::Serialize>(p: &std::path::Path, v: &T) -> anyhow::Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(&tmp, p)?;
    Ok(())
}

pub fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()))?;
        } else {
            std::fs::copy(&p, to.join(e.file_name()))?;
        }
    }
    Ok(())
}
