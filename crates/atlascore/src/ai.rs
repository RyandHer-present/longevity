//! Text generation with the Gemini (or Groq) key the user already set up in MioDeck.
//! Keys are read at call time and never written anywhere or printed.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct Keys {
    pub gemini: Option<String>,
    pub gemini_model: Option<String>,
    pub groq: Option<String>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys").field("gemini", &self.gemini.is_some()).field("groq", &self.groq.is_some()).finish()
    }
}

/// Read keys from MioDeck's settings (%APPDATA%\com.halo.dashboard\halo-settings.json).
pub fn load_keys() -> Keys {
    let Ok(appdata) = std::env::var("APPDATA") else { return Keys::default() };
    let p = std::path::Path::new(&appdata).join("com.halo.dashboard").join("halo-settings.json");
    let Ok(text) = std::fs::read_to_string(p) else { return Keys::default() };
    let Ok(outer) = serde_json::from_str::<Value>(&text) else { return Keys::default() };
    let inner: Value = match outer.get("settings") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    };
    let ai = inner.pointer("/state/ai").or_else(|| inner.get("ai")).cloned().unwrap_or(Value::Null);
    let s = |k: &str| ai.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Keys { gemini: s("geminiKey"), gemini_model: s("geminiModel"), groq: s("groqKey") }
}

pub fn status() -> Value {
    let k = load_keys();
    json!({ "gemini": k.gemini.is_some(), "groq": k.groq.is_some(), "model": k.gemini_model })
}

fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(240)).build()?)
}

fn gemini_models(c: &reqwest::blocking::Client, key: &str) -> Vec<String> {
    let Ok(r) = c.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200").header("x-goog-api-key", key).send() else { return vec![] };
    let Ok(v) = r.json::<Value>() else { return vec![] };
    let mut names: Vec<String> = v
        .get("models")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter(|m| m.get("supportedGenerationMethods").and_then(|s| s.as_array()).map(|s| s.iter().any(|x| x == "generateContent")).unwrap_or(false))
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(|n| n.trim_start_matches("models/").to_string()))
                .filter(|n| n.starts_with("gemini") && !n.contains("image") && !n.contains("tts") && !n.contains("embedding") && !n.contains("live") && !n.contains("audio"))
                .collect()
        })
        .unwrap_or_default();
    // Prefer newest flash (non-lite), then flash-lite, then pro.
    fn score(n: &str) -> (i32, i64) {
        let ver: i64 = n
            .trim_start_matches("gemini-")
            .split('-')
            .next()
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| (v * 100.0) as i64)
            .unwrap_or(0);
        let kind = if n.contains("flash") && !n.contains("lite") {
            3
        } else if n.contains("flash-lite") {
            2
        } else if n.contains("pro") {
            1
        } else {
            0
        };
        let penalty = if n.contains("preview") || n.contains("exp") { -1 } else { 0 };
        (kind * 2 + penalty, ver)
    }
    names.sort_by(|a, b| score(b).cmp(&score(a)));
    names
}

fn gemini_call(c: &reqwest::blocking::Client, key: &str, model: &str, system: &str, prompt: &str, max_tokens: u32, temperature: f32) -> Result<String> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": temperature, "maxOutputTokens": max_tokens }
    });
    let r = c.post(url).header("x-goog-api-key", key).json(&body).send().context("request")?;
    let status = r.status();
    let v: Value = r.json().unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("request failed");
        return Err(anyhow!("Gemini {model}: {status} {msg}"));
    }
    let text: String = v
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
        .map(|parts| parts.iter().filter(|p| !p.get("thought").and_then(|t| t.as_bool()).unwrap_or(false)).filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(anyhow!("Gemini {model}: empty response"));
    }
    Ok(text)
}

fn groq_call(c: &reqwest::blocking::Client, key: &str, system: &str, prompt: &str, max_tokens: u32) -> Result<String> {
    let models = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"];
    let mut last = anyhow!("no groq model worked");
    for m in models {
        let body = json!({ "model": m, "messages": [{"role":"system","content":system},{"role":"user","content":prompt}], "max_tokens": max_tokens.min(8000), "temperature": 0.85 });
        match c.post("https://api.groq.com/openai/v1/chat/completions").bearer_auth(key).json(&body).send() {
            Ok(r) => {
                let ok = r.status().is_success();
                let v: Value = r.json().unwrap_or(Value::Null);
                if ok {
                    if let Some(t) = v.pointer("/choices/0/message/content").and_then(|t| t.as_str()) {
                        return Ok(t.to_string());
                    }
                }
                last = anyhow!("Groq {m}: {}", v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("failed"));
            }
            Err(e) => last = anyhow!("Groq {m}: {e}"),
        }
    }
    Err(last)
}

/// Generate text. Tries the best available Gemini models, then Groq.
pub fn generate(system: &str, prompt: &str, max_tokens: u32, temperature: f32) -> Result<(String, String)> {
    let keys = load_keys();
    let c = client()?;
    let mut errors = Vec::new();
    if let Some(key) = &keys.gemini {
        let mut models = gemini_models(&c, key);
        if let Some(m) = &keys.gemini_model {
            if !models.contains(m) {
                models.push(m.clone());
            }
        }
        if models.is_empty() {
            models = vec!["gemini-2.5-flash".into(), "gemini-2.0-flash".into()];
        }
        for m in models.iter().take(5) {
            match gemini_call(&c, key, m, system, prompt, max_tokens, temperature) {
                Ok(t) => return Ok((t, m.clone())),
                Err(e) => errors.push(e.to_string()),
            }
        }
    }
    if let Some(key) = &keys.groq {
        match groq_call(&c, key, system, prompt, max_tokens) {
            Ok(t) => return Ok((t, "groq".into())),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if keys.gemini.is_none() && keys.groq.is_none() {
        return Err(anyhow!("No AI key found. Add a Gemini key in MioDeck's AI settings."));
    }
    Err(anyhow!(errors.join(" | ")))
}
