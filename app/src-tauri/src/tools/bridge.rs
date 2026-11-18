//! The file link with the Longevity Companion mod (see docs/PROTOCOL.md). Longevity writes
//! longevity-*.json; the mod writes companion-*.json. All writes are atomic.

use super::{now, read_json, write_json, R};
use crate::search::Index;
use crate::Ctx;
use mcassets::Assets;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn write_index(ctx: &Ctx, idx: &Index, assets: Option<&Assets>) {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut containers = Vec::with_capacity(idx.containers.len());
    for c in &idx.containers {
        let mut items = Vec::new();
        for it in &c.items {
            if let Some(a) = assets {
                names.entry(it.id.clone()).or_insert_with(|| a.lang.name(&it.id));
            }
            items.push(json!([it.id, it.count, it.name, it.enchants]));
            for inner in &it.contents {
                if let Some(a) = assets {
                    names.entry(inner.id.clone()).or_insert_with(|| a.lang.name(&inner.id));
                }
                items.push(json!([inner.id, inner.count, inner.name, inner.enchants, it.id]));
            }
        }
        containers.push(json!({ "id": c.id, "kind": c.kind, "dim": c.dim, "pos": c.pos, "name": c.name, "items": items }));
    }
    let _ = write_json(&ctx.dir.join("longevity-index.json"), &json!({ "t": now(), "names": names, "containers": containers }));
}

fn requests(ctx: &Ctx) -> Value {
    read_json(&ctx.dir.join("longevity-requests.json")).unwrap_or(json!({ "seq": 0, "find": null, "guide": null }))
}

fn bump(ctx: &Ctx, mut r: Value) -> R<()> {
    let seq = r.get("seq").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
    r["seq"] = json!(seq);
    r["t"] = json!(now());
    write_json(&ctx.dir.join("longevity-requests.json"), &r)
}

pub fn request_find(ctx: &Ctx, label: &str, targets: Vec<Value>) -> R<()> {
    let mut r = requests(ctx);
    r["find"] = if targets.is_empty() { Value::Null } else { json!({ "label": label, "until": now() + 5 * 60 * 1000, "targets": targets }) };
    bump(ctx, r)
}

pub fn request_guide(ctx: &Ctx, guide: Option<Value>) -> R<()> {
    let mut r = requests(ctx);
    r["guide"] = guide.unwrap_or(Value::Null);
    bump(ctx, r)
}

/// The mod's live file, with "fresh" = written in the last 5 s and in this world.
pub fn live(ctx: &Ctx) -> Value {
    let p = ctx.dir.join("companion-live.json");
    let Some(mut v) = read_json(&p) else { return json!({ "fresh": false }) };
    let t = v.get("t").and_then(|x| x.as_i64()).unwrap_or(0);
    let in_world = v.get("in_world").and_then(|x| x.as_bool()).unwrap_or(false);
    v["fresh"] = json!(in_world && now() - t < 5000);
    v
}

/// Progress through the cleanup guide, as written by the mod.
pub fn guide_progress(ctx: &Ctx) -> Value {
    read_json(&ctx.dir.join("companion-guide.json")).unwrap_or(Value::Null)
}
