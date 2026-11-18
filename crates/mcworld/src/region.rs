//! Anvil region files (`r.X.Z.mca`): 32x32 chunks, each compressed NBT.

use anyhow::{Context, Result, bail};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct Region {
    pub path: PathBuf,
    pub rx: i32,
    pub rz: i32,
    locations: Vec<(u32, u8)>,
    pub timestamps: Vec<u32>,
    data: Vec<u8>,
}

impl Region {
    /// Reads the whole file into memory (regions are at most a few MB; this keeps reads lock-free
    /// and safe while Minecraft writes, since we work on our own copy).
    pub fn open(path: &Path) -> Result<Region> {
        let (rx, rz) = parse_region_name(path).context("not a region file name")?;
        let mut f = File::open(path).with_context(|| format!("open {}", path.display()))?;
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;
        if data.len() < 8192 {
            // An empty or freshly created region
            return Ok(Region { path: path.to_path_buf(), rx, rz, locations: vec![(0, 0); 1024], timestamps: vec![0; 1024], data: Vec::new() });
        }
        let mut locations = Vec::with_capacity(1024);
        let mut timestamps = Vec::with_capacity(1024);
        for i in 0..1024 {
            let b = &data[i * 4..i * 4 + 4];
            let off = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            locations.push((off, b[3]));
            let t = &data[4096 + i * 4..4096 + i * 4 + 4];
            timestamps.push(u32::from_be_bytes([t[0], t[1], t[2], t[3]]));
        }
        Ok(Region { path: path.to_path_buf(), rx, rz, locations, timestamps, data })
    }

    /// Local chunk coords 0..32 that exist in this region.
    pub fn present(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        (0..1024).filter(|&i| self.locations[i].0 != 0 && self.locations[i].1 != 0).map(|i| (i % 32, i / 32))
    }

    pub fn has(&self, lx: usize, lz: usize) -> bool {
        let (o, c) = self.locations[lz * 32 + lx];
        o != 0 && c != 0
    }

    pub fn timestamp(&self, lx: usize, lz: usize) -> u32 {
        self.timestamps[lz * 32 + lx]
    }

    /// Raw decompressed NBT bytes for a chunk, or None if absent.
    pub fn chunk_bytes(&self, lx: usize, lz: usize) -> Result<Option<Vec<u8>>> {
        let (off, count) = self.locations[lz * 32 + lx];
        if off == 0 || count == 0 {
            return Ok(None);
        }
        let start = off as usize * 4096;
        if start + 5 > self.data.len() {
            return Ok(None); // truncated while being written
        }
        let len = u32::from_be_bytes([self.data[start], self.data[start + 1], self.data[start + 2], self.data[start + 3]]) as usize;
        let kind = self.data[start + 4];
        if len == 0 {
            return Ok(None);
        }
        let payload: Vec<u8> = if kind & 0x80 != 0 {
            // stored externally in c.X.Z.mcc
            let cx = self.rx * 32 + lx as i32;
            let cz = self.rz * 32 + lz as i32;
            let ext = self.path.with_file_name(format!("c.{cx}.{cz}.mcc"));
            std::fs::read(&ext).with_context(|| format!("external chunk {}", ext.display()))?
        } else {
            let end = (start + 4 + len).min(self.data.len());
            self.data[start + 5..end].to_vec()
        };
        decompress(kind & 0x7f, &payload).map(Some)
    }
}

pub fn decompress(kind: u8, payload: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(payload.len() * 4);
    match kind {
        1 => {
            flate2::read::GzDecoder::new(payload).read_to_end(&mut out)?;
        }
        2 => {
            flate2::read::ZlibDecoder::new(payload).read_to_end(&mut out)?;
        }
        3 => out.extend_from_slice(payload),
        4 => out = lz4_block_stream(payload)?,
        k => bail!("unknown chunk compression {k}"),
    }
    Ok(out)
}

/// lz4-java's LZ4BlockOutputStream framing, used by Minecraft's "lz4" region compression.
fn lz4_block_stream(mut p: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    while p.len() >= 21 {
        if &p[..8] != b"LZ4Block" {
            bail!("bad LZ4Block magic");
        }
        let token = p[8];
        let clen = i32::from_le_bytes([p[9], p[10], p[11], p[12]]) as usize;
        let dlen = i32::from_le_bytes([p[13], p[14], p[15], p[16]]) as usize;
        p = &p[21..];
        if dlen == 0 {
            break;
        }
        let block = &p[..clen.min(p.len())];
        match token & 0xF0 {
            0x10 => out.extend_from_slice(block),
            0x20 => {
                let d = lz4_flex::block::decompress(block, dlen).map_err(|e| anyhow::anyhow!("lz4: {e}"))?;
                out.extend_from_slice(&d);
            }
            m => bail!("unknown LZ4Block method {m:#x}"),
        }
        p = &p[clen.min(p.len())..];
    }
    Ok(out)
}

pub fn parse_region_name(path: &Path) -> Option<(i32, i32)> {
    let name = path.file_name()?.to_str()?;
    let mut it = name.split('.');
    if it.next()? != "r" {
        return None;
    }
    let x = it.next()?.parse().ok()?;
    let z = it.next()?.parse().ok()?;
    if it.next()? != "mca" {
        return None;
    }
    Some((x, z))
}

/// All region files in a folder.
pub fn list_regions(dir: &Path) -> Vec<(i32, i32, PathBuf)> {
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Some((x, z)) = parse_region_name(&p) {
                if e.metadata().map(|m| m.len() >= 8192).unwrap_or(false) {
                    v.push((x, z, p));
                }
            }
        }
    }
    v.sort_by_key(|r| (r.0, r.1));
    v
}

