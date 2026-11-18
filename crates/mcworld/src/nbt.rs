//! Small helpers over `fastnbt::Value` so the rest of the code reads cleanly.

pub use fastnbt::Value;
use std::collections::HashMap;
use std::io::Read;

pub fn parse(bytes: &[u8]) -> anyhow::Result<Value> {
    Ok(fastnbt::from_bytes::<Value>(bytes)?)
}

/// Read a gzip (or plain) NBT file like level.dat or player data.
pub fn read_file(path: &std::path::Path) -> anyhow::Result<Value> {
    let raw = std::fs::read(path)?;
    if raw.len() > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out)?;
        parse(&out)
    } else {
        parse(&raw)
    }
}

/// 1.21.5+ heterogeneous lists wrap non-compound elements as a compound with a single "" key.
pub fn unwrap_elem(v: &Value) -> &Value {
    if let Value::Compound(m) = v {
        if m.len() == 1 {
            if let Some(inner) = m.get("") {
                return inner;
            }
        }
    }
    v
}

pub trait V {
    fn get(&self, key: &str) -> Option<&Value>;
    fn compound(&self) -> Option<&HashMap<String, Value>>;
    fn list(&self) -> Option<&Vec<Value>>;
    fn str(&self) -> Option<&str>;
    fn i64(&self) -> Option<i64>;
    fn f64(&self) -> Option<f64>;
    fn path(&self, keys: &[&str]) -> Option<&Value>;
    fn int_array(&self) -> Option<Vec<i32>>;
    fn long_array(&self) -> Option<&[i64]>;
    fn byte_array(&self) -> Option<Vec<u8>>;
    fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| v.str())
    }
    fn get_i64(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|v| v.i64())
    }
    fn get_f64(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.f64())
    }
    fn get_list(&self, key: &str) -> &[Value] {
        self.get(key).and_then(|v| v.list()).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

impl V for Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Compound(m) => m.get(key),
            _ => None,
        }
    }
    fn compound(&self) -> Option<&HashMap<String, Value>> {
        match self {
            Value::Compound(m) => Some(m),
            _ => None,
        }
    }
    fn list(&self) -> Option<&Vec<Value>> {
        match self {
            Value::List(l) => Some(l),
            _ => None,
        }
    }
    fn str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
    fn i64(&self) -> Option<i64> {
        match self {
            Value::Byte(v) => Some(*v as i64),
            Value::Short(v) => Some(*v as i64),
            Value::Int(v) => Some(*v as i64),
            Value::Long(v) => Some(*v),
            Value::Float(v) => Some(*v as i64),
            Value::Double(v) => Some(*v as i64),
            _ => None,
        }
    }
    fn f64(&self) -> Option<f64> {
        match self {
            Value::Byte(v) => Some(*v as f64),
            Value::Short(v) => Some(*v as f64),
            Value::Int(v) => Some(*v as f64),
            Value::Long(v) => Some(*v as f64),
            Value::Float(v) => Some(*v as f64),
            Value::Double(v) => Some(*v),
            _ => None,
        }
    }
    fn path(&self, keys: &[&str]) -> Option<&Value> {
        let mut cur = self;
        for k in keys {
            cur = cur.get(k)?;
        }
        Some(cur)
    }
    fn int_array(&self) -> Option<Vec<i32>> {
        match self {
            Value::IntArray(a) => Some(a.iter().copied().collect()),
            Value::List(l) => l.iter().map(|v| v.i64().map(|x| x as i32)).collect(),
            _ => None,
        }
    }
    fn long_array(&self) -> Option<&[i64]> {
        match self {
            Value::LongArray(a) => Some(a),
            _ => None,
        }
    }
    fn byte_array(&self) -> Option<Vec<u8>> {
        match self {
            Value::ByteArray(a) => Some(a.iter().map(|b| *b as u8).collect()),
            _ => None,
        }
    }
}

/// A UUID stored as 4 ints -> canonical string.
pub fn uuid_from_ints(v: &Value) -> Option<String> {
    let a = v.int_array()?;
    if a.len() != 4 {
        return None;
    }
    let hex: String = a.iter().map(|i| format!("{:08x}", *i as u32)).collect();
    Some(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

/// Text components are either JSON strings (older) or NBT compounds/strings (newer). Get the plain text.
pub fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => {
            if s.starts_with('{') || s.starts_with('"') || s.starts_with('[') {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(s) {
                    return json_text(&j);
                }
            }
            s.clone()
        }
        Value::Compound(_) => {
            let mut out = v.get_str("text").unwrap_or("").to_string();
            if let Some(t) = v.get_str("translate") {
                if out.is_empty() {
                    out = t.to_string();
                }
            }
            for e in v.get_list("extra") {
                out.push_str(&text_of(e));
            }
            out
        }
        Value::List(l) => l.iter().map(text_of).collect(),
        _ => String::new(),
    }
}

fn json_text(j: &serde_json::Value) -> String {
    match j {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a.iter().map(json_text).collect(),
        serde_json::Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(extra) = o.get("extra").and_then(|e| e.as_array()) {
                for e in extra {
                    s.push_str(&json_text(e));
                }
            }
            s
        }
        _ => String::new(),
    }
}
