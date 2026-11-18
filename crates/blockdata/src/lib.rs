//! Shared block types used by the world reader (mcworld), the simulation (worldsim) and the mesher.
//! A world is a grid of 16x16x16 sections; each section has a palette of block states and 4096 indices.

use serde::{Deserialize, Serialize};
use std::fmt;

/// A Minecraft block state, e.g. `minecraft:oak_log[axis=y]`.
/// Properties are kept sorted by key so equal states compare equal.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct BlockState {
    pub name: String,
    pub props: Vec<(String, String)>,
}

impl BlockState {
    pub fn new(name: impl Into<String>) -> Self {
        let mut name = name.into();
        if !name.contains(':') {
            name = format!("minecraft:{name}");
        }
        Self { name, props: Vec::new() }
    }

    /// Builder: add a property (kept sorted).
    pub fn with(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        let k = k.into();
        let v = v.into();
        if let Some(p) = self.props.iter_mut().find(|(pk, _)| *pk == k) {
            p.1 = v;
        } else {
            self.props.push((k, v));
            self.props.sort();
        }
        self
    }

    pub fn prop(&self, k: &str) -> Option<&str> {
        self.props.iter().find(|(pk, _)| pk == k).map(|(_, v)| v.as_str())
    }

    /// Parse `minecraft:oak_log[axis=y,foo=bar]` (namespace optional).
    pub fn parse(s: &str) -> Self {
        let (name, rest) = match s.find('[') {
            Some(i) => (&s[..i], Some(&s[i + 1..s.len().saturating_sub(1)])),
            None => (s, None),
        };
        let mut b = BlockState::new(name);
        if let Some(rest) = rest {
            for kv in rest.split(',') {
                if let Some((k, v)) = kv.split_once('=') {
                    b = b.with(k.trim(), v.trim());
                }
            }
        }
        b
    }

    /// Name without the `minecraft:` namespace.
    pub fn short(&self) -> &str {
        self.name.strip_prefix("minecraft:").unwrap_or(&self.name)
    }

    pub fn is_air(&self) -> bool {
        matches!(self.short(), "air" | "cave_air" | "void_air")
    }
}

impl fmt::Display for BlockState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name)?;
        if !self.props.is_empty() {
            f.write_str("[")?;
            for (i, (k, v)) in self.props.iter().enumerate() {
                if i > 0 {
                    f.write_str(",")?;
                }
                write!(f, "{k}={v}")?;
            }
            f.write_str("]")?;
        }
        Ok(())
    }
}

/// One 16x16x16 section. `data[(y*16+z)*16+x]` indexes into `palette`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Section {
    pub palette: Vec<BlockState>,
    pub data: Vec<u16>,
    /// Biome name per 4x4x4 cell: `biomes[(y*4+z)*4+x]` indexes into `biome_palette`.
    pub biome_palette: Vec<String>,
    pub biomes: Vec<u8>,
}

impl Section {
    pub fn empty() -> Self {
        Self {
            palette: vec![BlockState::new("air")],
            data: vec![0; 4096],
            biome_palette: vec!["minecraft:plains".into()],
            biomes: vec![0; 64],
        }
    }

    #[inline]
    pub fn index(x: usize, y: usize, z: usize) -> usize {
        (y * 16 + z) * 16 + x
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize, z: usize) -> &BlockState {
        &self.palette[self.data[Self::index(x, y, z)] as usize]
    }

    /// Set a block, adding it to the palette if needed.
    pub fn set(&mut self, x: usize, y: usize, z: usize, state: &BlockState) {
        let id = match self.palette.iter().position(|p| p == state) {
            Some(i) => i,
            None => {
                self.palette.push(state.clone());
                self.palette.len() - 1
            }
        };
        self.data[Self::index(x, y, z)] = id as u16;
    }

    pub fn biome_at(&self, x: usize, y: usize, z: usize) -> &str {
        let i = ((y / 4) * 4 + (z / 4)) * 4 + (x / 4);
        self.biome_palette
            .get(*self.biomes.get(i).unwrap_or(&0) as usize)
            .map(|s| s.as_str())
            .unwrap_or("minecraft:plains")
    }

    pub fn is_all_air(&self) -> bool {
        self.palette.iter().all(|p| p.is_air())
    }
}

/// Anything the mesher can read blocks from (a real save, or a simulated world).
pub trait BlockSource: Sync {
    /// Section at section coords (cx, sy, cz). `sy` is the section Y (block y >> 4, may be negative).
    fn section(&self, cx: i32, sy: i32, cz: i32) -> Option<&Section>;
    /// Lowest and highest section Y that may exist.
    fn section_range(&self) -> (i32, i32);

    fn block(&self, x: i32, y: i32, z: i32) -> Option<&BlockState> {
        let s = self.section(x >> 4, y >> 4, z >> 4)?;
        Some(s.get((x & 15) as usize, (y & 15) as usize, (z & 15) as usize))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_roundtrip() {
        let b = BlockState::parse("minecraft:oak_stairs[half=bottom,facing=east]");
        assert_eq!(b.to_string(), "minecraft:oak_stairs[facing=east,half=bottom]");
        assert_eq!(b.prop("facing"), Some("east"));
        assert_eq!(BlockState::parse("stone").name, "minecraft:stone");
    }
}
