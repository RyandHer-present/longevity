//! Decoding a chunk's NBT into block sections, heightmaps, light, block entities and structures.

use crate::nbt::{V, Value};
use blockdata::{BlockState, Section};

#[derive(Clone, Debug, Default)]
pub struct Light {
    /// 2048 bytes of nibbles each, or None if absent (absent sky light means full dark/unknown).
    pub sky: Option<Vec<u8>>,
    pub block: Option<Vec<u8>>,
}

impl Light {
    #[inline]
    pub fn sky_at(&self, x: usize, y: usize, z: usize) -> u8 {
        nibble(self.sky.as_deref(), x, y, z, 15)
    }
    #[inline]
    pub fn block_at(&self, x: usize, y: usize, z: usize) -> u8 {
        nibble(self.block.as_deref(), x, y, z, 0)
    }
}

#[inline]
fn nibble(arr: Option<&[u8]>, x: usize, y: usize, z: usize, default: u8) -> u8 {
    match arr {
        Some(a) if a.len() == 2048 => {
            let i = (y * 16 + z) * 16 + x;
            let b = a[i >> 1];
            if i & 1 == 0 { b & 0xF } else { b >> 4 }
        }
        _ => default,
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StructureStart {
    pub id: String,
    /// min x,y,z max x,y,z (blocks)
    pub bbox: [i32; 6],
    pub chunk: (i32, i32),
}

pub struct Chunk {
    pub x: i32,
    pub z: i32,
    pub min_section: i32,
    pub sections: Vec<Option<Section>>,
    pub light: Vec<Light>,
    pub inhabited_time: i64,
    pub last_update: i64,
    pub status: String,
    /// Top non-air block Y per column (WORLD_SURFACE), index z*16+x. i32::MIN if unknown.
    pub surface: Option<Vec<i32>>,
    /// MOTION_BLOCKING heightmap (top solid-or-fluid block Y)
    pub motion: Option<Vec<i32>>,
    /// OCEAN_FLOOR heightmap (top solid block Y)
    pub ocean_floor: Option<Vec<i32>>,
    pub block_entities: Vec<Value>,
    pub structures: Vec<StructureStart>,
}

impl Chunk {
    pub fn section(&self, sy: i32) -> Option<&Section> {
        let i = sy - self.min_section;
        if i < 0 {
            return None;
        }
        self.sections.get(i as usize).and_then(|s| s.as_ref())
    }

    pub fn light(&self, sy: i32) -> Option<&Light> {
        let i = sy - self.min_section;
        if i < 0 {
            return None;
        }
        self.light.get(i as usize)
    }

    /// Block at chunk-local x/z and world y.
    pub fn block(&self, x: usize, y: i32, z: usize) -> Option<&BlockState> {
        self.section(y >> 4).map(|s| s.get(x, (y & 15) as usize, z))
    }

    pub fn is_full(&self) -> bool {
        self.status == "minecraft:full" || self.status == "full"
    }

    pub fn max_y(&self) -> i32 {
        (self.min_section + self.sections.len() as i32) * 16 - 1
    }
}

/// Decode a chunk. `light` controls whether light arrays are kept (needed for rendering, not for maps).
pub fn decode(root: &Value, keep_light: bool) -> anyhow::Result<Chunk> {
    let x = root.get_i64("xPos").unwrap_or(0) as i32;
    let z = root.get_i64("zPos").unwrap_or(0) as i32;
    let status = root.get_str("Status").unwrap_or("").to_string();
    let inhabited_time = root.get_i64("InhabitedTime").unwrap_or(0);
    let last_update = root.get_i64("LastUpdate").unwrap_or(0);

    let secs = root.get_list("sections");
    let mut ys: Vec<i32> = secs.iter().filter_map(|s| s.get_i64("Y").map(|v| v as i32)).collect();
    ys.sort();
    let min_section = root.get_i64("yPos").map(|v| v as i32).or_else(|| ys.first().copied()).unwrap_or(-4);
    let max_section = ys.last().copied().unwrap_or(min_section).max(min_section);
    let n = (max_section - min_section + 1) as usize;
    let mut sections: Vec<Option<Section>> = (0..n).map(|_| None).collect();
    let mut light: Vec<Light> = (0..n).map(|_| Light::default()).collect();

    for s in secs {
        let Some(sy) = s.get_i64("Y").map(|v| v as i32) else { continue };
        let idx = (sy - min_section) as usize;
        if idx >= n {
            continue;
        }
        if keep_light {
            light[idx] = Light { sky: s.get("SkyLight").and_then(|v| v.byte_array()), block: s.get("BlockLight").and_then(|v| v.byte_array()) };
        }
        let Some(bs) = s.get("block_states") else { continue };
        let palette: Vec<BlockState> = bs.get_list("palette").iter().map(block_state_of).collect();
        if palette.is_empty() {
            continue;
        }
        let data = match bs.get("data").and_then(|d| d.long_array()) {
            Some(longs) if palette.len() > 1 => unpack(longs, palette.len().max(2), 4096, 4),
            _ => vec![0u16; 4096],
        };
        let (biome_palette, biomes) = match s.get("biomes") {
            Some(b) => {
                let bp: Vec<String> = b.get_list("palette").iter().filter_map(|v| crate::nbt::unwrap_elem(v).str().map(|s| s.to_string())).collect();
                let bd = match b.get("data").and_then(|d| d.long_array()) {
                    Some(longs) if bp.len() > 1 => unpack(longs, bp.len(), 64, 1).into_iter().map(|v| v as u8).collect(),
                    _ => vec![0u8; 64],
                };
                (if bp.is_empty() { vec!["minecraft:plains".to_string()] } else { bp }, bd)
            }
            None => (vec!["minecraft:plains".to_string()], vec![0u8; 64]),
        };
        sections[idx] = Some(Section { palette, data, biome_palette, biomes });
    }

    let hm = root.get("Heightmaps");
    let read_hm = |name: &str| -> Option<Vec<i32>> {
        let longs = hm?.get(name)?.long_array()?;
        if longs.is_empty() {
            return None;
        }
        // bits per entry follow from the array length (256 entries, no spanning)
        let per = 256usize.div_ceil(longs.len());
        let bits = 64 / per;
        let vals = unpack_raw(longs, bits, 256);
        Some(vals.into_iter().map(|v| v as i32 + min_section * 16 - 1).collect())
    };
    let surface = read_hm("WORLD_SURFACE");
    let motion = read_hm("MOTION_BLOCKING");
    let ocean_floor = read_hm("OCEAN_FLOOR");

    let block_entities = root.get_list("block_entities").to_vec();

    let mut structures = Vec::new();
    if let Some(starts) = root.path(&["structures", "starts"]).and_then(|v| v.compound()) {
        for (id, st) in starts {
            if st.get_str("id") == Some("INVALID") {
                continue;
            }
            let mut bb = [i32::MAX, i32::MAX, i32::MAX, i32::MIN, i32::MIN, i32::MIN];
            for child in st.get_list("Children") {
                if let Some(b) = child.get("BB").and_then(|v| v.int_array()) {
                    if b.len() == 6 {
                        for k in 0..3 {
                            bb[k] = bb[k].min(b[k]);
                            bb[k + 3] = bb[k + 3].max(b[k + 3]);
                        }
                    }
                }
            }
            if bb[0] == i32::MAX {
                bb = [x * 16, 0, z * 16, x * 16 + 15, 0, z * 16 + 15];
            }
            structures.push(StructureStart { id: id.clone(), bbox: bb, chunk: (x, z) });
        }
    }

    Ok(Chunk { x, z, min_section, sections, light, inhabited_time, last_update, status, surface, motion, ocean_floor, block_entities, structures })
}

pub fn block_state_of(v: &Value) -> BlockState {
    // 26.x palettes: a plain string for blocks without properties, wrapped as {"": "name"} in mixed lists
    let v = crate::nbt::unwrap_elem(v);
    if let Some(name) = v.str() {
        return BlockState::new(name);
    }
    let mut b = BlockState::new(v.get_str("Name").or_else(|| v.get_str("id")).or_else(|| v.get_str("name")).unwrap_or("minecraft:air"));
    if let Some(props) = v.get("Properties").or_else(|| v.get("properties")).and_then(|p| p.compound()) {
        let mut ps: Vec<(String, String)> = props
            .iter()
            .map(|(k, v)| (k.clone(), v.str().map(|s| s.to_string()).or_else(|| v.i64().map(|i| if matches!(v, crate::nbt::Value::Byte(_)) { (i != 0).to_string() } else { i.to_string() })).unwrap_or_default()))
            .collect();
        ps.sort();
        b.props = ps;
    }
    b
}

fn bits_for(n: usize) -> usize {
    let mut b = 0;
    while (1usize << b) < n {
        b += 1;
    }
    b.max(1)
}

/// Paletted container unpack: entries don't span longs (1.16+).
fn unpack(longs: &[i64], palette_len: usize, count: usize, min_bits: usize) -> Vec<u16> {
    let bits = bits_for(palette_len).max(min_bits);
    unpack_raw(longs, bits, count).into_iter().map(|v| v as u16).collect()
}

fn unpack_raw(longs: &[i64], bits: usize, count: usize) -> Vec<u32> {
    let per = 64 / bits;
    let mask = (1u64 << bits) - 1;
    let mut out = Vec::with_capacity(count);
    'outer: for &l in longs {
        let l = l as u64;
        for i in 0..per {
            if out.len() >= count {
                break 'outer;
            }
            out.push(((l >> (i * bits)) & mask) as u32);
        }
    }
    out.resize(count, 0);
    out
}
