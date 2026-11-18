//! English names from en_us.json and death-message patterns for log parsing.

use crate::jar::Jar;
use std::collections::HashMap;

pub struct Lang {
    pub map: HashMap<String, String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct DeathPattern {
    pub key: String,
    /// The translated message with %1$s etc. replaced by `{0}`, `{1}`, `{2}`.
    pub template: String,
}

impl Lang {
    pub fn load(jar: &Jar) -> Lang {
        let map = jar
            .json("lang/en_us.json")
            .and_then(|j| j.as_object().cloned())
            .map(|o| o.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect())
            .unwrap_or_default();
        Lang { map }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }

    /// Display name for a block/item/entity/biome id like `minecraft:oak_log`.
    /// Like `name`, but a mob's name wins over the item of the same id (cod, not "Raw Cod").
    pub fn entity_name(&self, id: &str) -> String {
        let (ns, path) = id.split_once(':').unwrap_or(("minecraft", id));
        self.map.get(&format!("entity.{ns}.{path}")).cloned().unwrap_or_else(|| self.name(id))
    }

    pub fn name(&self, id: &str) -> String {
        let (ns, path) = id.split_once(':').unwrap_or(("minecraft", id));
        for kind in ["item", "block", "entity", "biome", "effect", "enchantment"] {
            if let Some(v) = self.map.get(&format!("{kind}.{ns}.{path}")) {
                return v.clone();
            }
        }
        // Title-case fallback
        path.split('_')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn advancement_title(&self, id: &str) -> Option<String> {
        // "minecraft:story/mine_stone" -> "advancements.story.mine_stone.title"
        let path = id.split_once(':').map(|p| p.1).unwrap_or(id);
        self.map.get(&format!("advancements.{}.title", path.replace('/', "."))).cloned()
    }

    pub fn advancement_description(&self, id: &str) -> Option<String> {
        let path = id.split_once(':').map(|p| p.1).unwrap_or(id);
        self.map.get(&format!("advancements.{}.description", path.replace('/', "."))).cloned()
    }

    pub fn death_patterns(&self) -> Vec<DeathPattern> {
        let mut out: Vec<DeathPattern> = self
            .map
            .iter()
            .filter(|(k, _)| k.starts_with("death.") && !k.starts_with("death.screen"))
            .map(|(k, v)| {
                let mut t = v.clone();
                for (i, pat) in ["%1$s", "%2$s", "%3$s"].iter().enumerate() {
                    t = t.replace(pat, &format!("{{{i}}}"));
                }
                // positional %s (rare in en_us) -> sequential
                let mut n = 0;
                while let Some(p) = t.find("%s") {
                    t.replace_range(p..p + 2, &format!("{{{n}}}"));
                    n += 1;
                }
                DeathPattern { key: k.clone(), template: t }
            })
            .collect();
        // Longer templates first so "was slain by X using Y" wins over "was slain by X".
        out.sort_by(|a, b| b.template.len().cmp(&a.template.len()));
        out
    }
}
